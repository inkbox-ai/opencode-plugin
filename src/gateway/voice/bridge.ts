import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { verifyWebhook } from "@inkbox/sdk";
import { type WebSocket, WebSocketServer } from "ws";
import type { InkboxRuntime } from "../../client.js";
import type { ResolvedConfig } from "../../config.js";
import { type ContactResolver, contactCard, type ResolvedContact } from "../contacts.js";
import type { GatewayLogger, SessionManager } from "../types.js";
import { buildVoiceGreeting, buildVoiceInstructions, type CallMeta } from "./instructions.js";
import { callEndedPrompt, createPostCallRegistry, postCallPrompt } from "./post-call.js";
import {
  callerAudio,
  callModeHeaders,
  parseFrame,
  sendAudioDone,
  sendClear,
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
// How long to wait for the OpenAI session (connect + session.update round
// trip) before falling back to Inkbox speech. Cold TLS/DNS can eat seconds.
const REALTIME_READY_TIMEOUT_MS = 10_000;

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
    const upgradeAt = deps.now();
    deps.logger.info("call.upgrade", { callId: ctx.callId });

    // Resolve who is on this call — counterparty, contact card, own identity —
    // BEFORE choosing a mode, so voice instructions carry the full picture.
    const meta = await resolveCallParties(ctx);

    // Decide the mode by actually trying OpenAI first (when enabled), so the
    // upgrade headers reflect a mode that will work. Transient API errors get
    // one retry; only then fall back to Inkbox speech (unless disabled).
    const rt = deps.config.gateway.voice.realtime;
    const apiKey = rt.enabled ? process.env[rt.apiKeyEnvVar] : undefined;
    let realtime: RealtimeBridge | undefined;
    if (rt.enabled && apiKey) {
      for (let attempt = 1; attempt <= 2 && !realtime; attempt++) {
        const t0 = deps.now();
        const candidate = tryOpenRealtime(apiKey, ctx, meta);
        if (await raceReady(candidate.ready)) {
          realtime = candidate;
        } else {
          await candidate.close().catch(() => {});
          deps.logger.warn("call.realtime_attempt_failed", { attempt, ms: deps.now() - t0 });
          // Retry only fast rejections (transient API errors); a slow failure
          // is a timeout, and a second wait would just stack dead air.
          if (deps.now() - t0 > 3000) break;
        }
      }
      if (!realtime && !rt.fallbackToInkboxSttTts) {
        deps.logger.warn("call.realtime_unavailable_no_fallback", {});
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const mode = realtime ? "raw-media" : "stt-tts";
    deps.logger.info("call.mode", { mode, ms: deps.now() - upgradeAt });
    extraHeaders.set(
      req,
      Object.entries(callModeHeaders(mode)).map(([k, v]) => `${k}: ${v}`),
    );

    wss.handleUpgrade(req, socket, head, (ws) => {
      void runCall(ws, ctx, meta, realtime).catch((err) => {
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

  // Fill in the counterparty (from the signed call record), the contact card,
  // the chat key, and our own identity — everything the call needs to know
  // who is talking to whom.
  async function resolveCallParties(ctx: CallCtx): Promise<CallMeta> {
    if (!ctx.from && ctx.callId) {
      try {
        const client = await deps.inkbox.getClient();
        const call = await client.calls.get(ctx.callId);
        ctx.from = call.remotePhoneNumber ?? "";
        if (call.direction === "inbound" || call.direction === "outbound") {
          ctx.direction = call.direction;
        }
      } catch (err) {
        deps.logger.warn("call.lookup_failed", { callId: ctx.callId, error: String(err) });
      }
    }

    let contact: ResolvedContact = {};
    if (ctx.from) {
      contact = await deps.contacts.resolve(ctx.from);
      ctx.card = contactCard(contact);
      ctx.chatKey = deps.contacts.chatKeyFor({
        contactId: contact.contactId,
        channel: "imessage",
        from: ctx.from,
      });
    } else {
      ctx.from = "unknown";
      ctx.card = contactCard({});
      ctx.chatKey = `call:${ctx.callId ?? "unknown"}`;
    }

    let identity: CallMeta["identity"] = {};
    try {
      const id = await deps.inkbox.getIdentity();
      identity = {
        handle: id.agentHandle,
        emailAddress: id.emailAddress,
        dedicatedNumber: id.phoneNumber?.number,
        imessageEnabled: (id as { imessageEnabled?: boolean }).imessageEnabled,
      };
    } catch (err) {
      deps.logger.warn("call.identity_failed", { error: String(err) });
    }

    return {
      callId: ctx.callId,
      direction: ctx.direction,
      from: ctx.from,
      contact,
      identity,
      purpose: ctx.purpose,
      openingMessage: ctx.openingMessage,
      context: ctx.context,
    };
  }

  // Open a Realtime bridge whose audio callbacks target the (soon-to-exist)
  // caller WS via a mutable ref, so we can connect to OpenAI before the
  // handshake completes.
  function tryOpenRealtime(
    apiKey: string,
    ctx: CallCtx,
    meta: CallMeta,
  ): RealtimeBridge & { attach(ws: WebSocket): void } {
    let callWs: WebSocket | undefined;
    const registry = createPostCallRegistry();
    const bridge = openRealtimeBridge(
      {
        apiKey,
        model: deps.config.gateway.voice.realtime.model,
        voice: deps.config.gateway.voice.realtime.voice,
        instructions: buildVoiceInstructions(meta),
      },
      registry,
      {
        onAudio: (b64) => callWs && sendMedia(callWs, b64),
        onAudioDone: () => callWs && sendAudioDone(callWs),
        onBargeIn: () => callWs && sendClear(callWs),
        onConsult: async (query) => {
          ctx.transcript.push(`caller: ${query}`);
          const answer = await deps.sessions.runText(ctx.chatKey, `${voiceTag(ctx)}\n${query}`);
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
    meta: CallMeta,
    realtime: RealtimeBridge | undefined,
  ): Promise<void> {
    deps.logger.info("call.connected", { chatKey: ctx.chatKey, realtime: Boolean(realtime) });
    const registry = ctx.registry ?? createPostCallRegistry();
    const greeting = ctx.openingMessage || GREETING;

    if (realtime) {
      (realtime as RealtimeBridge & { attach(ws: WebSocket): void }).attach(ws);
      realtime.start(buildVoiceGreeting(meta));
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
        deps.logger.info("call.transcript", { chatKey: ctx.chatKey, chars: text.length });
        ctx.transcript.push(`caller: ${text}`);
        const t0 = deps.now();
        let reply: string | undefined;
        try {
          reply = await deps.sessions.runText(ctx.chatKey, `${voiceTag(ctx)}\n${text}`);
        } catch (err) {
          deps.logger.error("call.turn_failed", { chatKey: ctx.chatKey, error: String(err) });
        }
        if (reply) {
          ctx.transcript.push(`agent: ${reply}`);
          speak(ws, reply, `turn-${ctx.transcript.length}`);
          deps.logger.info("call.reply", { chatKey: ctx.chatKey, ms: deps.now() - t0 });
        } else {
          // Never leave the caller in dead air on a failed or empty turn.
          speak(ws, "Sorry — I hit a snag handling that. Give it another try.", `err-${t0}`);
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
    const caller = `from=${ctx.from} call_id=${ctx.callId ?? "unknown"} | ${ctx.card}`;
    if (actions.length > 0) {
      await deps.sessions
        .runText(ctx.chatKey, postCallPrompt(actions, convo, caller))
        .catch(() => {});
    } else if (ctx.transcript.length > 0) {
      await deps.sessions.runText(ctx.chatKey, callEndedPrompt(convo, caller)).catch(() => {});
    }
  }

  // Per-turn routing tag for voice frames sent through the text agent.
  function voiceTag(ctx: CallCtx): string {
    return `[inkbox:voice from=${ctx.from} call_id=${ctx.callId ?? "unknown"} | ${ctx.card}]`;
  }

  interface CallCtx {
    from: string;
    callId?: string;
    direction: "inbound" | "outbound";
    purpose?: string;
    openingMessage?: string;
    context?: string;
    chatKey: string;
    // Rendered contact card for the counterparty, for [inkbox:voice] frames
    // and post-call prompts.
    card: string;
    transcript: string[];
    registry?: ReturnType<typeof createPostCallRegistry>;
  }

  // Build the call context from the SIGNED X-Call-Context body — it carries
  // call_id (+ the local line), not the counterparty; runCall resolves that
  // from the call record. Outbound-call hints (purpose/opening/context) ride
  // the URL we set when placing the call.
  function callContext(signedRaw: string, req: IncomingMessage): CallCtx {
    let signed: Record<string, unknown> = {};
    try {
      signed = signedRaw ? JSON.parse(signedRaw) : {};
    } catch {
      /* unsigned/empty context */
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const from = strOf(signed.remote_phone_number) ?? strOf(signed.from) ?? q("from") ?? "";
    const purpose = q("purpose");
    const openingMessage = q("opening_message");
    return {
      from,
      callId: strOf(signed.call_id) ?? strOf(signed.id) ?? q("call_id"),
      // Purpose/opening ride only on outbound call URLs; the call record's
      // direction (fetched later) is authoritative and overrides this.
      direction: purpose || openingMessage ? "outbound" : "inbound",
      purpose,
      openingMessage,
      context: q("context"),
      chatKey: from,
      card: contactCard({}),
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
