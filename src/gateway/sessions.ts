import type { OpencodeClient } from "@opencode-ai/sdk";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { frameCapture, frameInbound } from "./prompts.js";
import { deliverReply } from "./reply.js";
import type { StateStore } from "./state.js";
import type {
  GatewayLogger,
  InboundMessage,
  ReplyTarget,
  SessionManager,
  TurnKind,
} from "./types.js";

interface QueuedTurn {
  kind: TurnKind;
  text: string;
  deliver: boolean;
  replyTarget?: ReplyTarget;
  resolve: (out: string | undefined) => void;
  reject: (err: unknown) => void;
}

interface PerKey {
  queue: QueuedTurn[];
  running: boolean;
  // Kind of the turn currently executing, or undefined when idle. Only a
  // "normal" turn may be interrupted; captures always run to completion.
  runningKind?: TurnKind;
  // Set to interrupt the in-flight normal turn so its partial output is dropped.
  interruptNormal: boolean;
}

export interface SessionManagerDeps {
  opencode: OpencodeClient;
  inkbox: InkboxRuntime;
  config: ResolvedConfig;
  state: StateStore;
  logger: GatewayLogger;
  directory: string;
}

// One serialized turn queue per human (chatKey). A new inbound message while
// a normal turn is in flight interrupts it (the partial is dropped) and
// prompts fresh; capture turns always run to completion.
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const keys = new Map<string, PerKey>();
  let closing = false;

  function per(chatKey: string): PerKey {
    let entry = keys.get(chatKey);
    if (!entry) {
      entry = { queue: [], running: false, interruptNormal: false };
      keys.set(chatKey, entry);
    }
    return entry;
  }

  async function ensureSession(chatKey: string): Promise<string> {
    const existing = deps.state.getSession(chatKey);
    if (existing) return existing;
    const res = await deps.opencode.session.create({
      body: { title: `inkbox:${chatKey}` },
      query: { directory: deps.directory },
    });
    const id = (res as any)?.data?.id ?? (res as any)?.id;
    if (!id) throw new Error("opencode session.create returned no session id");
    deps.state.setSession(chatKey, id);
    deps.logger.info("session.created", { chatKey, sessionID: id });
    return id;
  }

  async function runPrompt(sessionID: string, text: string): Promise<string | undefined> {
    const g = deps.config.gateway;
    const res = await deps.opencode.session.prompt({
      path: { id: sessionID },
      query: { directory: deps.directory },
      body: {
        ...(g.agent ? { agent: g.agent } : {}),
        ...(g.model?.includes("/")
          ? {
              model: {
                providerID: g.model.split("/")[0],
                modelID: g.model.split("/").slice(1).join("/"),
              },
            }
          : {}),
        parts: [{ type: "text", text }],
      },
    });
    return extractText(res);
  }

  async function drain(chatKey: string): Promise<void> {
    const entry = per(chatKey);
    if (entry.running) return;
    entry.running = true;
    try {
      for (let turn = entry.queue.shift(); turn; turn = entry.queue.shift()) {
        entry.runningKind = turn.kind;
        if (turn.kind === "normal") entry.interruptNormal = false;
        try {
          const sessionID = await ensureSession(chatKey);
          const out = await runPrompt(sessionID, turn.text);
          // If a newer message interrupted this normal turn, drop its output.
          if (turn.kind === "normal" && entry.interruptNormal) {
            deps.logger.info("turn.interrupted", { chatKey });
            turn.resolve(undefined);
            continue;
          }
          if (turn.deliver && turn.replyTarget && out !== undefined) {
            await deliverReply(deps.inkbox, turn.replyTarget, out, deps.logger).catch((err) => {
              deps.logger.error("reply.failed", { chatKey, error: String(err) });
            });
          }
          turn.resolve(out);
        } catch (err) {
          deps.logger.error("turn.failed", { chatKey, error: String(err) });
          turn.reject(err);
        }
      }
    } finally {
      entry.running = false;
      entry.runningKind = undefined;
    }
  }

  // Interrupt the in-flight turn ONLY when it is a normal turn; capture turns
  // (voice, delivery failures, external events) always run to completion.
  async function interruptInFlightNormal(chatKey: string, sessionID: string): Promise<void> {
    const entry = per(chatKey);
    if (!entry.running || entry.runningKind !== "normal") return;
    entry.interruptNormal = true;
    try {
      await deps.opencode.session.abort({
        path: { id: sessionID },
        query: { directory: deps.directory },
      });
    } catch (err) {
      // Abort racing normal completion is fine: the completed turn delivers,
      // and the queued message runs next as an ordinary turn.
      deps.logger.warn("session.abort.race", { chatKey, error: String(err) });
    }
  }

  return {
    async handleInbound(msg: InboundMessage) {
      if (closing) return;
      const replyTarget: ReplyTarget = {
        channel: msg.channel,
        to: msg.from,
        conversationId: msg.conversationId,
        subject: msg.subject,
        rfcMessageId: msg.rfcMessageId,
      };
      const entry = per(msg.chatKey);
      // A new inbound while a NORMAL turn runs interrupts it. Await the abort
      // before enqueuing so it can't outlive its turn and truncate the next.
      if (entry.running && entry.runningKind === "normal") {
        const sessionID = deps.state.getSession(msg.chatKey);
        if (sessionID) await interruptInFlightNormal(msg.chatKey, sessionID);
      }
      await new Promise<string | undefined>((resolve, reject) => {
        entry.queue.push({
          kind: "normal",
          text: frameInbound(msg),
          deliver: true,
          replyTarget,
          resolve,
          reject,
        });
        void drain(msg.chatKey);
      });
    },

    async runCapture(chatKey, text) {
      return this.runText(chatKey, frameCapture("event", text));
    },

    async runText(chatKey, framedText) {
      if (closing) return undefined;
      const entry = per(chatKey);
      return new Promise<string | undefined>((resolve, reject) => {
        entry.queue.push({
          kind: "capture",
          text: framedText,
          deliver: false,
          resolve,
          reject,
        });
        void drain(chatKey);
      });
    },

    async resetSession(chatKey) {
      // Abort any in-flight turn first so a pending escalation on the old
      // session doesn't get orphaned by the mapping being cleared.
      await this.abortTurn(chatKey);
      deps.state.clearSession(chatKey);
      deps.logger.info("session.reset", { chatKey });
    },

    async abortTurn(chatKey) {
      const sessionID = deps.state.getSession(chatKey);
      const entry = keys.get(chatKey);
      if (!sessionID || !entry?.running) return false;
      // Only a normal turn is interruptible; a running capture finishes.
      if (entry.runningKind === "normal") entry.interruptNormal = true;
      // Settle every dropped queued turn so no caller (and no held-open
      // webhook response) hangs forever.
      const dropped = entry.queue;
      entry.queue = [];
      for (const turn of dropped) turn.resolve(undefined);
      await deps.opencode.session
        .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
        .catch(() => {});
      return true;
    },

    status(chatKey) {
      const entry = keys.get(chatKey);
      return { busy: Boolean(entry?.running), sessionID: deps.state.getSession(chatKey) };
    },

    async close() {
      closing = true;
      const pending = [...keys.values()].map(
        (entry) =>
          new Promise<void>((resolve) => {
            if (!entry.running && entry.queue.length === 0) return resolve();
            const check = setInterval(() => {
              if (!entry.running && entry.queue.length === 0) {
                clearInterval(check);
                resolve();
              }
            }, 25);
            check.unref?.();
          }),
      );
      await Promise.all(pending);
    },
  };
}

// Pull assistant text from a prompt response. The pinned prompt route
// returns { info, parts }; concatenate text parts.
export function extractText(res: unknown): string | undefined {
  const data = (res as any)?.data ?? res;
  const parts = data?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}
