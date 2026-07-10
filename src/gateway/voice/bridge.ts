import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { InkboxRuntime } from "../../client.js";
import type { ResolvedConfig } from "../../config.js";
import type { ContactResolver } from "../contacts.js";
import type { GatewayLogger, SessionManager } from "../types.js";
import { callEndedPrompt, createPostCallRegistry, postCallPrompt } from "./post-call.js";
import { callModeHeaders, parseFrame, sendMedia, speak } from "./protocol.js";
import { openRealtimeBridge, type RealtimeBridge } from "./realtime.js";

export interface CallBridgeDeps {
  config: ResolvedConfig;
  inkbox: InkboxRuntime;
  contacts: ContactResolver;
  sessions: SessionManager;
  logger: GatewayLogger;
  now: () => number;
}

const GREETING = "Hi, you've reached the assistant. How can I help?";

// Owns the /phone/media/ws endpoint. Each call picks a mode: OpenAI Realtime
// raw-media when configured and reachable, otherwise Inkbox speech-to-text /
// text-to-speech. The upgrade response headers must reflect the chosen mode.
export function createCallBridge(deps: CallBridgeDeps) {
  const wss = new WebSocketServer({ noServer: true });
  // Extra 101-response headers chosen per request (mode selection).
  const extraHeaders = new WeakMap<IncomingMessage, string[]>();
  wss.on("headers", (headers, req) => {
    for (const h of extraHeaders.get(req) ?? []) headers.push(h);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const rt = deps.config.gateway.voice.realtime;
    const apiKey = rt.enabled ? process.env[rt.apiKeyEnvVar] : undefined;
    const useRealtime = Boolean(rt.enabled && apiKey);

    // Header choice must be set before the handshake completes.
    const mode = useRealtime ? "raw-media" : "stt-tts";
    extraHeaders.set(
      req,
      Object.entries(callModeHeaders(mode)).map(([k, v]) => `${k}: ${v}`),
    );

    wss.handleUpgrade(req, socket, head, (ws) => {
      void runCall(ws, req, { useRealtime, apiKey }).catch((err) => {
        deps.logger.error("call.failed", { error: String(err) });
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      });
    });
  }

  async function runCall(
    ws: WebSocket,
    req: IncomingMessage,
    opts: { useRealtime: boolean; apiKey: string | undefined },
  ): Promise<void> {
    const ctx = callContext(req);
    // Outbound calls carry purpose/opening/context as URL params; use them to
    // open with context instead of a generic greeting.
    const greeting = ctx.openingMessage || GREETING;
    const instructions = [ctx.purpose ? `Call purpose: ${ctx.purpose}` : "", ctx.context ?? ""]
      .filter(Boolean)
      .join("\n");
    const { contactId } = await deps.contacts.resolve(ctx.from);
    const chatKey = deps.contacts.chatKeyFor({
      contactId,
      channel: "imessage",
      from: ctx.from,
    });
    const registry = createPostCallRegistry();
    const transcript: string[] = [];
    deps.logger.info("call.connected", { chatKey, realtime: opts.useRealtime });

    let realtime: RealtimeBridge | undefined;
    if (opts.useRealtime && opts.apiKey) {
      realtime = openRealtimeBridge(
        {
          apiKey: opts.apiKey,
          model: deps.config.gateway.voice.realtime.model,
          voice: deps.config.gateway.voice.realtime.voice,
          instructions: [greeting, instructions].filter(Boolean).join("\n\n"),
        },
        registry,
        {
          onAudio: (b64) => sendMedia(ws, b64),
          onConsult: async (query) => {
            transcript.push(`caller: ${query}`);
            const answer = await deps.sessions.runText(
              chatKey,
              `[inkbox:voice from=${ctx.from}]\n${query}`,
            );
            if (answer) transcript.push(`agent: ${answer}`);
            return answer ?? "Done.";
          },
          onHangup: () => {
            try {
              ws.close();
            } catch {
              /* already closing */
            }
          },
          logger: deps.logger,
        },
        deps.now,
      );
      // If Realtime never becomes ready, fall through to STT/TTS handling of
      // frames (Inkbox keeps sending transcripts because we cannot re-issue
      // headers; the fallbackToInkboxSttTts flag governs whether that is ok).
      realtime.ready.catch(() => {
        deps.logger.warn("call.realtime_unready", { chatKey });
      });
    }

    ws.on("message", (data) => {
      const frame = parseFrame(data);
      if (!frame) return;
      void onFrame(frame);
    });

    async function onFrame(frame: ReturnType<typeof parseFrame>): Promise<void> {
      if (!frame) return;
      if (frame.event === "media" && realtime && typeof frame.media === "string") {
        realtime.pushAudio(frame.media);
        return;
      }
      if (frame.event === "start" && !realtime) {
        speak(ws, greeting, "greeting");
        return;
      }
      if (frame.event === "transcript" && frame.is_final && !realtime) {
        const text = String(frame.text ?? "").trim();
        if (!text) return;
        transcript.push(`caller: ${text}`);
        const reply = await deps.sessions.runText(
          chatKey,
          `[inkbox:voice from=${ctx.from}]\n${text}`,
        );
        if (reply) {
          transcript.push(`agent: ${reply}`);
          speak(ws, reply, `turn-${transcript.length}`);
        }
        return;
      }
      if (frame.event === "stop") {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }

    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await realtime?.close();
    deps.logger.info("call.ended", { chatKey });

    // Post-call: run queued actions, or a reflection turn, off the closed call.
    const actions = registry.list();
    const convo = transcript.join("\n");
    if (actions.length > 0) {
      await deps.sessions.runText(chatKey, postCallPrompt(actions, convo)).catch(() => {});
    } else if (transcript.length > 0) {
      await deps.sessions.runText(chatKey, callEndedPrompt(convo)).catch(() => {});
    }
  }

  return { handleUpgrade };
}

function callContext(req: IncomingMessage): {
  from: string;
  callId?: string;
  purpose?: string;
  openingMessage?: string;
  context?: string;
} {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = (k: string) => url.searchParams.get(k) ?? undefined;
  return {
    from:
      p("from") ??
      p("remote_phone_number") ??
      (req.headers["x-inkbox-from"] as string) ??
      "unknown",
    callId: p("call_id"),
    purpose: p("purpose"),
    openingMessage: p("opening_message"),
    context: p("context"),
  };
}
