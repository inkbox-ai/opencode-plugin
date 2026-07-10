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
  close(): Promise<void>;
  // Resolves when the socket is ready (session configured).
  ready: Promise<void>;
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
  const ws = makeSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    {
      Authorization: `Bearer ${config.apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  );
  const hangup = createHangupArmer(HANGUP_WINDOW_MS, now);
  const consults = new Set<Promise<void>>();
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: config.instructions,
          voice: config.voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: "whisper-1" },
          tools: realtimeTools(),
          tool_choice: "auto",
        },
      }),
    );
    // Speak the opening proactively rather than waiting for the caller — a
    // silent callee (voicemail) still hears the opening message.
    ws.send(JSON.stringify({ type: "response.create" }));
    resolveReady();
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
      case "response.function_call_arguments.done":
        void dispatchFunctionCall(evt);
        break;
      case "error":
        cb.logger.warn("realtime.error", { message: String(evt.error?.message ?? "") });
        break;
    }
  });

  ws.on("close", () => cb.logger.info("realtime.closed", {}));
  ws.on("error", (err) => cb.logger.warn("realtime.socket_error", { error: String(err) }));

  async function dispatchFunctionCall(evt: any): Promise<void> {
    const name: string = evt.name;
    const callId: string = evt.call_id;
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
