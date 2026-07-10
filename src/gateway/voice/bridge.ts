import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { verifyWebhook } from "@inkbox/sdk";
import { type WebSocket, WebSocketServer } from "ws";
import type { InkboxRuntime } from "../../client.js";
import type { ResolvedConfig } from "../../config.js";
import type { ContactResolver } from "../contacts.js";
import type { GatewayLogger, SessionManager } from "../types.js";
import { callEndedPrompt, createPostCallRegistry, postCallPrompt } from "./post-call.js";
import {
  callerAudio,
  callModeHeaders,
  parseFrame,
  sendAudioDone,
  sendMedia,
  speak,
} from "./protocol.js";
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
// How long to wait for the OpenAI socket before falling back to Inkbox speech.
const REALTIME_READY_TIMEOUT_MS = 4000;

// Owns the /phone/media/ws endpoint. The upgrade is authenticated with the
// Inkbox webhook signature over the X-Call-Context header, and the caller
// identity is read from that signed context — never from untrusted query
// params. Each call runs in OpenAI Realtime raw-media mode when configured and
// reachable, otherwise Inkbox speech-to-text / text-to-speech.
export function createCallBridge(deps: CallBridgeDeps) {
  const wss = new WebSocketServer({ noServer: true });
  const extraHeaders = new WeakMap<IncomingMessage, string[]>();
  wss.on("headers", (headers, req) => {
    for (const h of extraHeaders.get(req) ?? []) headers.push(h);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Authenticate the upgrade before doing anything else.
    const headers = lowerHeaders(req.headers);
    const callContextRaw = headers["x-call-context"] ?? "";
    if (deps.config.gateway.requireSignature) {
      const secret = deps.config.signingKey;
      const ok =
        Boolean(secret) &&
        verifyWebhook({ payload: callContextRaw, headers, secret: secret as string });
      if (!ok) {
        deps.logger.warn("call.bad_signature", {});
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const ctx = callContext(callContextRaw, req);

    // Decide the mode by actually trying OpenAI first (when enabled), so the
    // upgrade headers reflect a mode that will work. If Realtime can't be
    // reached, fall back to Inkbox speech unless the operator disabled that.
    const rt = deps.config.gateway.voice.realtime;
    const apiKey = rt.enabled ? process.env[rt.apiKeyEnvVar] : undefined;
    let realtime: RealtimeBridge | undefined;
    if (rt.enabled && apiKey) {
      realtime = tryOpenRealtime(apiKey, ctx);
      const ready = await raceReady(realtime.ready);
      if (!ready) {
        await realtime.close().catch(() => {});
        realtime = undefined;
        if (!rt.fallbackToInkboxSttTts) {
          deps.logger.warn("call.realtime_unavailable_no_fallback", {});
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }
      }
    }

    const mode = realtime ? "raw-media" : "stt-tts";
    extraHeaders.set(
      req,
      Object.entries(callModeHeaders(mode)).map(([k, v]) => `${k}: ${v}`),
    );

    wss.handleUpgrade(req, socket, head, (ws) => {
      void runCall(ws, ctx, realtime).catch((err) => {
        deps.logger.error("call.failed", { error: String(err) });
        void realtime?.close().catch(() => {});
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      });
    });
  }

  // Open a Realtime bridge whose audio callbacks target the (soon-to-exist)
  // caller WS via a mutable ref, so we can connect to OpenAI before the
  // handshake completes.
  function tryOpenRealtime(
    apiKey: string,
    ctx: CallCtx,
  ): RealtimeBridge & { attach(ws: WebSocket): void } {
    let callWs: WebSocket | undefined;
    const registry = createPostCallRegistry();
    const greeting = ctx.openingMessage || GREETING;
    const instructions = [
      greeting,
      ctx.purpose ? `Call purpose: ${ctx.purpose}` : "",
      ctx.context ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const bridge = openRealtimeBridge(
      {
        apiKey,
        model: deps.config.gateway.voice.realtime.model,
        voice: deps.config.gateway.voice.realtime.voice,
        instructions,
      },
      registry,
      {
        onAudio: (b64) => callWs && sendMedia(callWs, b64),
        onAudioDone: () => callWs && sendAudioDone(callWs),
        onConsult: async (query) => {
          ctx.transcript.push(`caller: ${query}`);
          const answer = await deps.sessions.runText(
            ctx.chatKey,
            `[inkbox:voice from=${ctx.from}]\n${query}`,
          );
          if (answer) ctx.transcript.push(`agent: ${answer}`);
          return answer ?? "Done.";
        },
        onHangup: () => {
          try {
            callWs?.close();
          } catch {
            /* already closing */
          }
        },
        logger: deps.logger,
      },
      deps.now,
    );
    ctx.registry = registry;
    return Object.assign(bridge, {
      attach(ws: WebSocket) {
        callWs = ws;
      },
    });
  }

  function raceReady(ready: Promise<void>): Promise<boolean> {
    return Promise.race([
      ready.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), REALTIME_READY_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  }

  async function runCall(
    ws: WebSocket,
    ctx: CallCtx,
    realtime: RealtimeBridge | undefined,
  ): Promise<void> {
    // Resolve the caller to a stable per-contact chat key (falls back to the
    // raw address on lookup failure).
    const { contactId } = await deps.contacts.resolve(ctx.from);
    ctx.chatKey = deps.contacts.chatKeyFor({ contactId, channel: "imessage", from: ctx.from });
    deps.logger.info("call.connected", { chatKey: ctx.chatKey, realtime: Boolean(realtime) });
    const registry = ctx.registry ?? createPostCallRegistry();
    const greeting = ctx.openingMessage || GREETING;

    if (realtime) {
      (realtime as RealtimeBridge & { attach(ws: WebSocket): void }).attach(ws);
      realtime.start();
    }

    ws.on("message", (data) => {
      const frame = parseFrame(data);
      if (!frame) return;
      void onFrame(frame);
    });

    async function onFrame(frame: NonNullable<ReturnType<typeof parseFrame>>): Promise<void> {
      if (frame.event === "media" && realtime) {
        const audio = callerAudio(frame);
        if (audio) realtime.pushAudio(audio);
        return;
      }
      if (frame.event === "start" && !realtime) {
        speak(ws, greeting, "greeting");
        return;
      }
      if (frame.event === "transcript" && frame.is_final && !realtime) {
        const text = String(frame.text ?? "").trim();
        if (!text) return;
        ctx.transcript.push(`caller: ${text}`);
        const reply = await deps.sessions.runText(
          ctx.chatKey,
          `[inkbox:voice from=${ctx.from}]\n${text}`,
        );
        if (reply) {
          ctx.transcript.push(`agent: ${reply}`);
          speak(ws, reply, `turn-${ctx.transcript.length}`);
        }
        return;
      }
      if (frame.event === "stop" || frame.event === "closed" || frame.event === "hangup") {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }

    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await realtime?.close();
    deps.logger.info("call.ended", { chatKey: ctx.chatKey });

    // Post-call: run queued actions, or a reflection turn, off the closed call.
    const actions = registry.list();
    const convo = ctx.transcript.join("\n");
    if (actions.length > 0) {
      await deps.sessions.runText(ctx.chatKey, postCallPrompt(actions, convo)).catch(() => {});
    } else if (ctx.transcript.length > 0) {
      await deps.sessions.runText(ctx.chatKey, callEndedPrompt(convo)).catch(() => {});
    }
  }

  interface CallCtx {
    from: string;
    callId?: string;
    purpose?: string;
    openingMessage?: string;
    context?: string;
    chatKey: string;
    transcript: string[];
    registry?: ReturnType<typeof createPostCallRegistry>;
  }

  // Build the call context from the SIGNED X-Call-Context body. Outbound-call
  // hints (purpose/opening/context) ride the URL we set when placing the call.
  function callContext(signedRaw: string, req: IncomingMessage): CallCtx {
    let signed: Record<string, unknown> = {};
    try {
      signed = signedRaw ? JSON.parse(signedRaw) : {};
    } catch {
      /* unsigned/empty context */
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const from = strOf(signed.remote_phone_number) ?? strOf(signed.from) ?? q("from") ?? "unknown";
    return {
      from,
      callId: strOf(signed.id) ?? q("call_id"),
      purpose: q("purpose"),
      openingMessage: q("opening_message"),
      context: q("context"),
      chatKey: from,
      transcript: [],
    };
  }

  return { handleUpgrade };
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function lowerHeaders(h: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(",");
  }
  return out;
}
