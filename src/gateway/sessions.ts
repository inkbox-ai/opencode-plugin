import type { OpencodeClient } from "@opencode-ai/sdk";
import { type ActiveA2ATurn, clearActiveA2ATurn, setActiveA2ATurn } from "../a2a-context.js";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { buildIdentitySystem, frameCapture, frameInbound } from "./prompts.js";
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
  // Per-contact/per-channel opencode agent override for this turn.
  agent?: string;
  replyTarget?: ReplyTarget;
  // True for a follow-up turn enqueued after a delivery failure, so a second
  // failure doesn't spawn another recovery (bounded to one attempt).
  recovered?: boolean;
  a2aContext?: ActiveA2ATurn;
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
  runningA2ATaskId?: string;
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

  // The agent's own-identity system message, resolved once (lazily) and
  // attached to every turn so the model always knows its own addresses.
  let identitySystemCache: string | undefined;
  let identityResolved = false;
  async function identitySystem(): Promise<string | undefined> {
    if (identityResolved) return identitySystemCache;
    identityResolved = true;
    try {
      const id = await deps.inkbox.getIdentity();
      identitySystemCache = buildIdentitySystem({
        handle: id.agentHandle,
        emailAddress: id.emailAddress,
        dedicatedNumber: id.phoneNumber?.number,
        imessageEnabled: (id as { imessageEnabled?: boolean }).imessageEnabled,
      });
    } catch (err) {
      // A resolution failure must not block turns; retry on the next turn.
      identityResolved = false;
      deps.logger.warn("gateway.identity_unresolved", { error: String(err) });
    }
    return identitySystemCache;
  }

  function per(chatKey: string): PerKey {
    let entry = keys.get(chatKey);
    if (!entry) {
      entry = { queue: [], running: false, interruptNormal: false };
      keys.set(chatKey, entry);
    }
    return entry;
  }

  // A persisted session can rot: deleted server-side, or created against a
  // different (possibly deleted) project directory in an earlier deployment.
  // Prompting such a session 500s, so validate before reuse.
  async function sessionUsable(id: string): Promise<boolean> {
    try {
      const res = await deps.opencode.session.get({
        path: { id },
        query: { directory: deps.directory },
      });
      if ((res as any)?.error) return false;
      const dir = (res as any)?.data?.directory;
      return dir === undefined || dir === deps.directory;
    } catch {
      return false;
    }
  }

  async function ensureSession(chatKey: string): Promise<string> {
    const existing = deps.state.getSession(chatKey);
    if (existing) {
      if (await sessionUsable(existing)) return existing;
      deps.state.clearSession(chatKey);
      deps.logger.warn("session.stale_dropped", { chatKey, sessionID: existing });
    }
    const res = await deps.opencode.session.create({
      body: { title: `inkbox:${chatKey}` },
      query: { directory: deps.directory },
    });
    const id = (res as any)?.data?.id ?? (res as any)?.id;
    if (!id) {
      const err = (res as any)?.error;
      throw new Error(
        `opencode session.create returned no session id${err ? `: ${JSON.stringify(err).slice(0, 300)}` : ""}`,
      );
    }
    deps.state.setSession(chatKey, id);
    deps.logger.info("session.created", { chatKey, sessionID: id });
    return id;
  }

  async function runPrompt(
    sessionID: string,
    text: string,
    agentOverride?: string,
  ): Promise<string | undefined> {
    const g = deps.config.gateway;
    const agent = agentOverride ?? g.agent;
    const system = await identitySystem();
    const res = await deps.opencode.session.prompt({
      path: { id: sessionID },
      query: { directory: deps.directory },
      body: {
        ...(agent ? { agent } : {}),
        ...(system ? { system } : {}),
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
    // The generated client reports failures via res.error instead of throwing;
    // treating that as an empty reply would silently swallow the turn.
    const err = (res as any)?.error;
    if (err) throw new Error(`session.prompt failed: ${JSON.stringify(err).slice(0, 300)}`);
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
          if (turn.a2aContext) {
            entry.runningA2ATaskId = turn.a2aContext.taskId;
            setActiveA2ATurn(sessionID, turn.a2aContext);
          }
          let out: string | undefined;
          try {
            out = await runPrompt(sessionID, turn.text, turn.agent);
          } catch (err) {
            // A session that passed validation can still fail server-side
            // (stale project state); one retry on a brand-new session keeps
            // the contact reachable instead of failing the turn.
            deps.logger.warn("turn.retry_fresh_session", { chatKey, error: String(err) });
            deps.state.clearSession(chatKey);
            out = await runPrompt(await ensureSession(chatKey), turn.text, turn.agent);
          }
          // If a newer message interrupted this normal turn, drop its output.
          if (turn.kind === "normal" && entry.interruptNormal) {
            deps.logger.info("turn.interrupted", { chatKey });
            turn.resolve(undefined);
            continue;
          }
          if (turn.deliver && turn.replyTarget && out !== undefined) {
            try {
              await deliverReply(deps.inkbox, turn.replyTarget, out, deps.logger);
            } catch (err) {
              deps.logger.error("reply.failed", { chatKey, error: String(err) });
              // One bounded recovery turn: tell the agent the send failed so it
              // can shorten or switch channel. A recovery that also fails stops.
              if (!turn.recovered && turn.replyTarget) {
                entry.queue.push({
                  kind: "normal",
                  text: `Your previous reply could not be delivered (${err instanceof Error ? err.message : String(err)}). Send a shorter plain-text reply, or handle it another way.`,
                  deliver: true,
                  replyTarget: turn.replyTarget,
                  recovered: true,
                  resolve: () => {},
                  reject: () => {},
                });
              }
            }
          }
          turn.resolve(out);
        } catch (err) {
          deps.logger.error("turn.failed", { chatKey, error: String(err) });
          turn.reject(err);
        } finally {
          const sessionID = deps.state.getSession(chatKey);
          if (sessionID && turn.a2aContext) {
            clearActiveA2ATurn(sessionID, turn.a2aContext);
          }
          entry.runningA2ATaskId = undefined;
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
      // Operator overrides, keyed by contact id first, then channel.
      const g = deps.config.gateway;
      const overrideFor = (map: Record<string, string>): string | undefined =>
        (msg.contactId ? map[msg.contactId] : undefined) ?? map[msg.channel];
      await new Promise<string | undefined>((resolve, reject) => {
        entry.queue.push({
          kind: "normal",
          text: frameInbound(msg, overrideFor(g.channelPrompts)),
          deliver: true,
          agent: overrideFor(g.channelAgents),
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

    async runA2A(chatKey, framedText, context) {
      if (closing) return undefined;
      const entry = per(chatKey);
      return new Promise<string | undefined>((resolve, reject) => {
        entry.queue.push({
          kind: "capture",
          text: framedText,
          deliver: false,
          a2aContext: context,
          resolve,
          reject,
        });
        void drain(chatKey);
      });
    },

    async abortA2A(chatKey, taskId) {
      const entry = keys.get(chatKey);
      if (!entry) return false;
      const kept: QueuedTurn[] = [];
      let removed = false;
      for (const turn of entry.queue) {
        if (turn.a2aContext?.taskId === taskId) {
          turn.resolve(undefined);
          removed = true;
        } else {
          kept.push(turn);
        }
      }
      entry.queue = kept;
      if (entry.runningA2ATaskId !== taskId) return removed;
      const sessionID = deps.state.getSession(chatKey);
      if (!sessionID) return removed;
      await deps.opencode.session
        .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
        .catch(() => {});
      return true;
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
