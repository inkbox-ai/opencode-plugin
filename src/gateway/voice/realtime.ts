import { WebSocket } from "ws";
import type { GatewayLogger } from "../types.js";
import { createHangupArmer, type PostCallRegistry } from "./post-call.js";

export const CONSULT_TOOL = "consult_agent";
export const REGISTER_ACTION_TOOL = "register_post_call_action";
export const EDIT_ACTION_TOOL = "edit_post_call_action";
export const DELETE_ACTION_TOOL = "delete_post_call_action";
export const HANG_UP_TOOL = "hang_up_call";
const HANGUP_WINDOW_MS = 10_000;

export interface RealtimeConfig {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}

export interface RealtimeCallbacks {
  // Play μ-law audio (base64) back to the caller.
  onAudio(base64Ulaw: string): void;
  // A spoken response finished; flush the caller-side playback.
  onAudioDone?(): void;
  // The caller started talking over the model — clear queued playback.
  onBargeIn?(): void;
  // Run a full agent turn in the caller's session; the returned text is
  // spoken back. Runs off the audio pump so speech never freezes.
  onConsult(query: string): Promise<string>;
  // The model asked to end the call (after the two-step arm).
  onHangup(): void;
  logger: GatewayLogger;
}

// Function tools exposed to the Realtime model. Writes are brokered through
// consult_agent (a real agent turn); post-call actions queue follow-up work.
export function realtimeTools() {
  return [
    {
      type: "function",
      name: CONSULT_TOOL,
      description:
        "Ask your text-based agent to do real work or look something up (send a message, check an account, fetch context). Returns what to say next.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What you need done or answered." } },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: REGISTER_ACTION_TOOL,
      description: "Queue a follow-up action to run after the call ends.",
      parameters: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"],
      },
    },
    {
      type: "function",
      name: EDIT_ACTION_TOOL,
      description: "Change a queued post-call action.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, description: { type: "string" } },
        required: ["id", "description"],
      },
    },
    {
      type: "function",
      name: DELETE_ACTION_TOOL,
      description: "Cancel a queued post-call action.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      type: "function",
      name: HANG_UP_TOOL,
      description:
        "End the call. Call once to arm (say goodbye first), then again within a few seconds to actually hang up.",
      parameters: { type: "object", properties: {} },
    },
  ];
}

export interface RealtimeBridge {
  // Feed caller μ-law audio (base64) into the model.
  pushAudio(base64Ulaw: string): void;
  // Trigger the opening response once the caller leg is connected, with an
  // optional per-call greeting instruction.
  start(greetingInstructions?: string): void;
  close(): Promise<void>;
  // Resolves when the session is configured, rejects if the socket fails to
  // open — so the caller can fall back to Inkbox speech before committing.
  ready: Promise<void>;
}

interface FnCall {
  callId: string;
  name: string;
  args: string;
}

// Open a bidirectional bridge to the OpenAI Realtime API. Caller audio is
// appended to the input buffer (server-side VAD handles turn-taking); model
// audio deltas are played back; function calls are dispatched off the pump.
export function openRealtimeBridge(
  config: RealtimeConfig,
  registry: PostCallRegistry,
  cb: RealtimeCallbacks,
  now: () => number,
  makeSocket: (url: string, headers: Record<string, string>) => WebSocket = defaultSocket,
): RealtimeBridge {
  // GA Realtime endpoint: model is required in the URL query; no beta header.
  const ws = makeSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    { Authorization: `Bearer ${config.apiKey}` },
  );
  const hangup = createHangupArmer(HANGUP_WINDOW_MS, now);
  const consults = new Set<Promise<void>>();
  // Function calls arrive across three events: output_item.added carries the
  // name + call id, arguments.delta streams the JSON, arguments.done fires the
  // dispatch. Accumulate by item/call id.
  const fnCalls = new Map<string, FnCall>();
  let readySettled = false;
  let resolveReady: () => void;
  let rejectReady: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // ready settles exactly once: resolved by session.updated (the API accepted
  // our config), rejected by an error event or a close before that — so the
  // caller can still fall back to Inkbox speech on a post-open rejection.
  const settleReady = (fn: () => void) => {
    if (readySettled) return;
    readySettled = true;
    fn();
  };

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: config.model,
          output_modalities: ["audio"],
          instructions: config.instructions,
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: { model: "whisper-1" },
              // Server-side VAD: the model detects turn boundaries, responds
              // on its own, and supports caller barge-in.
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                // Shorter close = snappier turn-taking on phone audio.
                silence_duration_ms: 400,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: config.voice,
            },
          },
          tools: realtimeTools(),
          tool_choice: "auto",
        },
      }),
    );
  });

  ws.on("message", (data) => {
    let evt: any;
    try {
      evt = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (evt.type) {
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (typeof evt.delta === "string") cb.onAudio(evt.delta);
        break;
      case "response.output_audio.done":
      case "response.audio.done":
        cb.onAudioDone?.();
        break;
      case "response.output_item.added": {
        const item = evt.item ?? {};
        if (item.type === "function_call") {
          const key = evt.item_id ?? item.id ?? item.call_id ?? "";
          fnCalls.set(key, {
            callId: item.call_id ?? "",
            name: item.name ?? "",
            args: item.arguments ?? "",
          });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = evt.item_id ?? evt.call_id ?? "";
        const entry = fnCalls.get(key) ?? { callId: evt.call_id ?? "", name: "", args: "" };
        if (!entry.callId && evt.call_id) entry.callId = evt.call_id;
        if (typeof evt.delta === "string") entry.args += evt.delta;
        fnCalls.set(key, entry);
        break;
      }
      case "response.function_call_arguments.done": {
        const key = evt.item_id ?? evt.call_id ?? "";
        const entry = fnCalls.get(key) ?? fnCalls.get(evt.call_id ?? "");
        fnCalls.delete(key);
        void dispatchFunctionCall({
          name: entry?.name ?? evt.name ?? "",
          call_id: entry?.callId ?? evt.call_id ?? "",
          arguments: entry?.args || evt.arguments || "",
        });
        break;
      }
      case "session.updated":
        settleReady(resolveReady);
        break;
      case "input_audio_buffer.speech_started":
        // Server VAD already cancels the in-flight response; the audio that
        // was streamed ahead must be dropped downstream too.
        cb.onBargeIn?.();
        break;
      case "error": {
        const message = String(evt.error?.message ?? "");
        cb.logger.warn("realtime.error", { message });
        settleReady(() => rejectReady(new Error(`realtime session rejected: ${message}`)));
        break;
      }
    }
  });

  ws.on("close", () => {
    cb.logger.info("realtime.closed", {});
    settleReady(() =>
      rejectReady(new Error("realtime socket closed before the session was established")),
    );
  });
  ws.on("error", (err) => {
    cb.logger.warn("realtime.socket_error", { error: String(err) });
    settleReady(() => rejectReady(err instanceof Error ? err : new Error(String(err))));
  });

  async function dispatchFunctionCall(evt: {
    name: string;
    call_id: string;
    arguments: string;
  }): Promise<void> {
    const name = evt.name;
    const callId = evt.call_id;
    let args: any = {};
    try {
      args = evt.arguments ? JSON.parse(evt.arguments) : {};
    } catch {
      /* tolerate empty/invalid args */
    }
    if (name === HANG_UP_TOOL) {
      if (hangup.press()) {
        respond(callId, "Ending the call now.");
        cb.onHangup();
      } else {
        respond(callId, "Armed. Say goodbye, then call hang_up_call once more to end.");
      }
      return;
    }
    if (name === REGISTER_ACTION_TOOL) {
      const id = registry.register(String(args.description ?? ""));
      return respond(callId, `Queued (id ${id}).`);
    }
    if (name === EDIT_ACTION_TOOL) {
      const ok = registry.edit(String(args.id), String(args.description ?? ""));
      return respond(callId, ok ? "Updated." : "No such queued action.");
    }
    if (name === DELETE_ACTION_TOOL) {
      return respond(callId, registry.remove(String(args.id)) ? "Cancelled." : "No such action.");
    }
    if (name === CONSULT_TOOL) {
      // Run the agent turn off the audio pump so speech keeps flowing.
      const task = (async () => {
        try {
          const answer = await cb.onConsult(String(args.query ?? ""));
          respond(callId, answer || "Done.");
        } catch (err) {
          cb.logger.warn("realtime.consult_failed", { error: String(err) });
          respond(callId, "I hit a problem doing that.");
        }
      })();
      consults.add(task);
      void task.finally(() => consults.delete(task));
    }
  }

  // Return a function-call result to the model and ask it to speak.
  function respond(callId: string, output: string): void {
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      }),
    );
    ws.send(JSON.stringify({ type: "response.create" }));
  }

  return {
    pushAudio(base64Ulaw) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Ulaw }));
      }
    },
    start(greetingInstructions) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "response.create",
            ...(greetingInstructions ? { response: { instructions: greetingInstructions } } : {}),
          }),
        );
      }
    },
    ready,
    async close() {
      await Promise.allSettled([...consults]);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

function defaultSocket(url: string, headers: Record<string, string>): WebSocket {
  return new WebSocket(url, { headers });
}
