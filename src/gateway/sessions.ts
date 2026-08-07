import { randomBytes, randomUUID } from "node:crypto";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { type ActiveA2ATurn, clearActiveA2ATurn, setActiveA2ATurn } from "../a2a-context.js";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import {
  clearDeliveryFailures,
  deliveryFailureKey,
  deliveryFailureRecovery,
} from "./delivery-policy.js";
import {
  activateHostedSmsCapture,
  clearHostedSmsCapture,
  getHostedCall,
} from "./hosted-call-registry.js";
import { buildIdentitySystem, frameCapture, frameInbound } from "./prompts.js";
import { deliverReply } from "./reply.js";
import type { DurableHostedCapture, DurableTurn, StateStore } from "./state.js";
import type {
  GatewayLogger,
  InboundMessage,
  ReplyTarget,
  SessionManager,
  TurnKind,
} from "./types.js";
import { HostedCaptureDeferredError } from "./types.js";

interface TurnWaiter {
  resolve: (out: string | undefined) => void;
  reject: (err: unknown) => void;
  hostedResolve?: (result: {
    output?: string;
    attempt?: import("./hosted-call-registry.js").HostedSmsAttempt;
  }) => void;
}

interface PerKey {
  queue: string[];
  runningId?: string;
}

export interface SessionManagerDeps {
  opencode: OpencodeClient;
  inkbox: InkboxRuntime;
  config: ResolvedConfig;
  state: StateStore;
  logger: GatewayLogger;
  directory: string;
}

const TERMINAL = new Set(["delivered", "failed", "interrupted"]);
const ACTIVE = new Set(["queued", "submitting", "submitted", "delivery_started"]);
const INTERRUPTIBLE = ["queued", "submitting", "submitted"] as const;
const POLL_MS = 250;
const LEASE_MS = 60_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMessageSequence = 0n;

function createMessageID(): string {
  const current = BigInt(Date.now()) * 0x1000n + 1n;
  lastMessageSequence = current > lastMessageSequence ? current : lastMessageSequence + 1n;
  const timestamp = (lastMessageSequence & 0xffffffffffffn).toString(16).padStart(12, "0");
  const random = [...randomBytes(14)].map((byte) => BASE62[byte % BASE62.length]).join("");
  return `msg_${timestamp}${random}`;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const keys = new Map<string, PerKey>();
  const waiters = new Map<string, TurnWaiter[]>();
  const ownerId = randomUUID();
  let closing = false;

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
      identityResolved = false;
      deps.logger.warn("gateway.identity_unresolved", { error: String(err) });
    }
    return identitySystemCache;
  }

  function per(chatKey: string): PerKey {
    let entry = keys.get(chatKey);
    if (!entry) {
      entry = { queue: [] };
      keys.set(chatKey, entry);
    }
    return entry;
  }

  function addWaiter(id: string, waiter: TurnWaiter): void {
    waiters.set(id, [...(waiters.get(id) ?? []), waiter]);
  }

  function settle(id: string, output: string | undefined, error?: unknown): void {
    const pending = waiters.get(id) ?? [];
    waiters.delete(id);
    for (const waiter of pending) {
      if (error) waiter.reject(error);
      else if (waiter.hostedResolve) {
        const turn = deps.state.getTurn(id);
        const capture = turn?.hostedCapture;
        const entry = capture ? getHostedCall(capture.identityId, capture.callId) : undefined;
        waiter.hostedResolve({
          output,
          attempt: entry?.smsAttempts.find((attempt) => attempt.phase === capture?.phase),
        });
      } else waiter.resolve(output);
    }
  }

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

  async function promptBody(turn: DurableTurn): Promise<Record<string, unknown>> {
    const g = deps.config.gateway;
    const agent = turn.agent ?? g.agent;
    const system = await identitySystem();
    let tools: Record<string, boolean> | undefined;
    if (turn.hostedCapture) {
      // Hosted post-call turns expose only the tools required to complete
      // communication commitments from the finished call.
      const listed = await deps.opencode.tool.ids({ query: { directory: deps.directory } });
      const ids = (listed as any)?.data ?? listed;
      if (!Array.isArray(ids)) throw new Error("Could not restrict the hosted post-call turn.");
      tools = Object.fromEntries(ids.map((id) => [String(id), false]));
      if (turn.hostedCapture.phase === "correction") {
        tools.inkbox_send_sms = true;
      } else {
        for (const id of ids.map(String)) {
          if (id.startsWith("inkbox_") && !id.includes("_a2a_")) tools[id] = true;
        }
      }
    }
    return {
      messageID: turn.messageID,
      ...(agent ? { agent } : {}),
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      ...(g.model?.includes("/")
        ? {
            model: {
              providerID: g.model.split("/")[0],
              modelID: g.model.split("/").slice(1).join("/"),
            },
          }
        : {}),
      parts: [{ type: "text", text: turn.text }],
    };
  }

  async function listMessages(sessionID: string): Promise<any[]> {
    const res = await deps.opencode.session.messages({
      path: { id: sessionID },
      query: { directory: deps.directory },
    });
    const err = (res as any)?.error;
    if (err) throw new Error(`session.messages failed: ${JSON.stringify(err).slice(0, 300)}`);
    const messages = (res as any)?.data ?? res;
    return Array.isArray(messages) ? messages : [];
  }

  async function wasAccepted(turn: DurableTurn): Promise<boolean> {
    if (!turn.sessionID) return false;
    return (await listMessages(turn.sessionID)).some(
      (message) => message?.info?.id === turn.messageID,
    );
  }

  async function submit(turn: DurableTurn): Promise<DurableTurn> {
    const sessionID = turn.sessionID ?? (await ensureSession(turn.chatKey));
    const next = deps.state.transitionTurn(turn.id, ["queued"], {
      state: "submitting",
      sessionID,
    });
    if (!next) {
      const current = deps.state.getTurn(turn.id);
      if (current?.state === "interrupted") return current;
      throw new Error("Durable turn changed before submission.");
    }
    if (next.a2aContext) setActiveA2ATurn(sessionID, next.a2aContext);
    if (next.hostedCapture) {
      activateHostedSmsCapture({ ...next.hostedCapture, sessionID, ownerId });
    }
    try {
      const res = await deps.opencode.session.promptAsync({
        path: { id: sessionID },
        query: { directory: deps.directory },
        body: (await promptBody(next)) as never,
      });
      const err = (res as any)?.error;
      if (err) throw new Error(`session.promptAsync failed: ${JSON.stringify(err).slice(0, 300)}`);
      const submitted = deps.state.transitionTurn(turn.id, ["submitting"], {
        state: "submitted",
      });
      if (submitted) return submitted;
      const current = deps.state.getTurn(turn.id);
      if (current?.state === "interrupted") return current;
      throw new Error("Durable turn changed during submission.");
    } catch (err) {
      if (await wasAccepted(next).catch(() => false)) {
        deps.logger.warn("turn.submit_outcome_reconciled", { chatKey: next.chatKey });
        const submitted = deps.state.transitionTurn(turn.id, ["submitting"], {
          state: "submitted",
        });
        if (submitted) return submitted;
        const current = deps.state.getTurn(turn.id);
        if (current?.state === "interrupted") return current;
        throw new Error("Durable turn changed during submission reconciliation.");
      }
      deps.state.transitionTurn(turn.id, ["submitting"], {
        state: "failed",
        error: String(err),
      });
      throw err;
    }
  }

  async function completion(turn: DurableTurn): Promise<string | undefined> {
    if (!turn.sessionID) throw new Error("Submitted turn has no session id.");
    while (!closing) {
      if (!deps.state.claimTurn(turn.id, ownerId, LEASE_MS)) {
        throw new Error("Durable turn lease was lost.");
      }
      if (deps.state.getTurn(turn.id)?.state === "interrupted") return undefined;
      const messages = await listMessages(turn.sessionID);
      const userIndex = messages.findIndex((message) => message?.info?.id === turn.messageID);
      if (userIndex < 0) {
        if (turn.state === "submitting") throw new Error("Prompt acceptance is ambiguous.");
        await delay(POLL_MS);
        continue;
      }
      const statusRes = await deps.opencode.session.status({
        query: { directory: deps.directory },
      });
      const statuses = (statusRes as any)?.data ?? statusRes;
      if (statuses?.[turn.sessionID]?.type === "busy") {
        await delay(POLL_MS);
        continue;
      }
      const assistants = messages
        .slice(userIndex + 1)
        .filter(
          (message) =>
            message?.info?.role === "assistant" && message.info.parentID === turn.messageID,
        );
      const last = assistants.at(-1);
      if (last?.info?.error) {
        throw new Error(`OpenCode turn failed: ${JSON.stringify(last.info.error).slice(0, 300)}`);
      }
      if (last?.info?.time?.completed || last?.info?.finish) return extractText(last);
      await delay(POLL_MS);
    }
    throw new HostedCaptureDeferredError();
  }

  async function finish(turn: DurableTurn, output: string | undefined): Promise<void> {
    if (!deps.state.claimTurn(turn.id, ownerId, LEASE_MS)) {
      throw new Error("Durable turn lease was lost.");
    }
    if (deps.state.getTurn(turn.id)?.state === "interrupted") {
      settle(turn.id, undefined);
      return;
    }
    let current = turn;
    if (turn.state !== "completed") {
      const completed = deps.state.transitionTurn(turn.id, ["submitted"], {
        state: "completed",
        output,
      });
      if (!completed) {
        const latest = deps.state.getTurn(turn.id);
        if (latest?.state === "interrupted") {
          settle(turn.id, undefined);
          return;
        }
        throw new Error("Durable turn changed before completion.");
      }
      current = completed;
    }
    if (current.deliver && current.replyTarget && output !== undefined) {
      deps.state.updateTurn(current.id, { state: "delivery_started" });
      try {
        const sent = await deliverReply(deps.inkbox, current.replyTarget, output, deps.logger);
        deps.state.updateTurn(current.id, {
          state: "delivered",
          deliveryMessageId: sent.messageId,
        });
      } catch (err) {
        deps.state.updateTurn(current.id, { state: "failed", error: String(err) });
        deps.logger.error("reply.failed", { chatKey: current.chatKey, error: String(err) });
        const recovery = deliveryFailureRecovery({
          key: deliveryFailureKey(
            current.replyTarget.channel,
            current.replyTarget.to,
            current.replyTarget.conversationId,
          ),
          channel: current.replyTarget.channel,
          target: current.replyTarget.to,
          failure: err,
          failedBody: output,
        });
        if (recovery.prompt)
          enqueue(makeTurn(current.chatKey, "normal", recovery.prompt, true, current.replyTarget));
      }
    }
    settle(current.id, output);
  }

  async function process(id: string): Promise<void> {
    let turn = deps.state.claimTurn(id, ownerId, LEASE_MS);
    if (!turn) {
      const current = deps.state.getTurn(id);
      if (current && ACTIVE.has(current.state) && !closing) {
        const wait = Math.max(POLL_MS, (current.leaseUntil ?? Date.now()) - Date.now() + POLL_MS);
        const timer = setTimeout(() => enqueue(current), wait);
        timer.unref?.();
      }
      return;
    }
    if (TERMINAL.has(turn.state)) return;
    try {
      if (turn.state === "queued") turn = await submit(turn);
      else if (turn.state === "submitting") {
        if (!(await wasAccepted(turn))) throw new Error("Prompt submission outcome is ambiguous.");
        turn =
          deps.state.transitionTurn(id, ["submitting"], { state: "submitted" }) ??
          deps.state.getTurn(id) ??
          turn;
      }
      if (turn.state === "submitted" && turn.sessionID) {
        if (turn.a2aContext) setActiveA2ATurn(turn.sessionID, turn.a2aContext);
        if (turn.hostedCapture) {
          activateHostedSmsCapture({
            ...turn.hostedCapture,
            sessionID: turn.sessionID,
            ownerId,
          });
        }
      }
      if (turn.state === "interrupted") {
        settle(id, undefined);
        return;
      }
      if (turn.state === "submitted") await finish(turn, await completion(turn));
      else if (turn.state === "completed") await finish(turn, turn.output);
      else if (turn.state === "delivery_started") {
        deps.state.updateTurn(id, {
          state: "failed",
          error: "Reply delivery outcome is ambiguous after restart.",
        });
      }
    } catch (err) {
      const latest = deps.state.getTurn(id);
      const leaseLost = String(err).includes("Durable turn lease was lost");
      if (!closing && !leaseLost && latest && !TERMINAL.has(latest.state)) {
        deps.state.updateTurn(id, { state: "failed", error: String(err) });
      }
      deps.logger.error("turn.failed", { chatKey: turn.chatKey, error: String(err) });
      if (!(leaseLost && turn.hostedCapture)) settle(id, undefined, err);
    } finally {
      if (turn.hostedCapture) {
        try {
          const latest = deps.state.getTurn(turn.id);
          if (!(closing && latest && ACTIVE.has(latest.state))) {
            clearHostedSmsCapture(
              turn.hostedCapture.identityId,
              turn.hostedCapture.callId,
              ownerId,
            );
          }
        } catch (err) {
          deps.logger.warn("hosted_call.capture_cleanup_failed", {
            callId: turn.hostedCapture.callId,
            error: String(err),
          });
        }
      }
      if (turn.sessionID && turn.a2aContext) clearActiveA2ATurn(turn.sessionID, turn.a2aContext);
    }
  }

  async function drain(chatKey: string): Promise<void> {
    const entry = per(chatKey);
    if (entry.runningId) return;
    for (let id = entry.queue.shift(); id; id = entry.queue.shift()) {
      const turn = deps.state.getTurn(id);
      if (!turn || TERMINAL.has(turn.state)) continue;
      entry.runningId = id;
      let retry = false;
      try {
        await process(id);
      } catch (error) {
        const current = deps.state.getTurn(id);
        deps.logger.error("turn.drain_failed", { chatKey, error: String(error) });
        if (!closing && current && ACTIVE.has(current.state)) {
          entry.queue.unshift(id);
          retry = true;
        } else {
          settle(
            id,
            undefined,
            closing && current?.hostedCapture ? new HostedCaptureDeferredError() : error,
          );
        }
      } finally {
        entry.runningId = undefined;
      }
      if (retry) {
        const timer = setTimeout(() => void drain(chatKey), POLL_MS);
        timer.unref?.();
        break;
      }
    }
  }

  function enqueue(turn: DurableTurn): void {
    if (!deps.state.getTurn(turn.id)) deps.state.saveTurn(turn);
    const entry = per(turn.chatKey);
    if (entry.runningId !== turn.id && !entry.queue.includes(turn.id)) entry.queue.push(turn.id);
    void drain(turn.chatKey);
  }

  function makeTurn(
    chatKey: string,
    kind: TurnKind,
    text: string,
    deliver: boolean,
    replyTarget?: ReplyTarget,
    extra: Partial<DurableTurn> = {},
  ): DurableTurn {
    const id = createMessageID();
    const now = Date.now();
    return {
      id,
      messageID: id,
      chatKey,
      state: "queued",
      kind,
      text,
      deliver,
      replyTarget,
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
  }

  function promiseFor(turn: DurableTurn, hosted = false): Promise<any> {
    return new Promise((resolve, reject) => {
      addWaiter(
        turn.id,
        hosted ? { resolve: () => {}, reject, hostedResolve: resolve } : { resolve, reject },
      );
      enqueue(turn);
    });
  }

  function hostedMatch(capture: DurableHostedCapture): DurableTurn | undefined {
    return deps.state
      .listTurns()
      .filter(
        (turn) =>
          turn.hostedCapture?.identityId === capture.identityId &&
          turn.hostedCapture.callId === capture.callId &&
          turn.hostedCapture.phase === capture.phase &&
          turn.state !== "failed" &&
          turn.state !== "interrupted",
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  function a2aMatch(context: ActiveA2ATurn): DurableTurn | undefined {
    return deps.state
      .listTurns()
      .filter(
        (turn) =>
          turn.a2aContext?.taskId === context.taskId &&
          turn.a2aContext.messageId === context.messageId &&
          turn.state !== "failed" &&
          turn.state !== "interrupted",
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  return {
    async handleInbound(msg: InboundMessage) {
      if (closing) return;
      const target: ReplyTarget = {
        channel: msg.channel,
        to: msg.from,
        conversationId: msg.conversationId,
        subject: msg.subject,
        rfcMessageId: msg.rfcMessageId,
      };
      deps.state.setReplyTarget(msg.chatKey, target);
      clearDeliveryFailures(deliveryFailureKey(msg.channel, msg.from, msg.conversationId));
      const g = deps.config.gateway;
      const overrideFor = (map: Record<string, string>): string | undefined =>
        (msg.contactId ? map[msg.contactId] : undefined) ?? map[msg.channel];
      const turn = makeTurn(
        msg.chatKey,
        "normal",
        frameInbound(msg, overrideFor(g.channelPrompts)),
        true,
        target,
        {
          agent: overrideFor(g.channelAgents),
        },
      );
      const interrupted = deps.state
        .listTurns()
        .filter(
          (candidate) =>
            candidate.chatKey === msg.chatKey &&
            candidate.kind === "normal" &&
            Boolean(candidate.ownerId) &&
            INTERRUPTIBLE.includes(candidate.state as (typeof INTERRUPTIBLE)[number]),
        )
        .flatMap((candidate) => {
          const updated = deps.state.transitionTurn(candidate.id, [...INTERRUPTIBLE], {
            state: "interrupted",
          });
          return updated ? [updated] : [];
        });
      deps.state.saveTurn(turn);
      const sessionIDs = new Set(
        interrupted
          .map((candidate) => candidate.sessionID ?? deps.state.getSession(candidate.chatKey))
          .filter((sessionID): sessionID is string => Boolean(sessionID)),
      );
      for (const sessionID of sessionIDs) {
        await deps.opencode.session
          .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
          .catch(() => {});
      }
      return promiseFor(turn);
    },

    async runCapture(chatKey, text) {
      return this.runText(chatKey, frameCapture("event", text));
    },

    async runText(chatKey, text) {
      if (closing) return undefined;
      return promiseFor(makeTurn(chatKey, "capture", text, false));
    },

    async runHostedCapture(chatKey, text, capture) {
      if (closing) throw new HostedCaptureDeferredError();
      const existing = hostedMatch(capture);
      if (existing?.state === "completed") {
        const entry = getHostedCall(capture.identityId, capture.callId);
        return {
          output: existing.output,
          attempt: entry?.smsAttempts.find((attempt) => attempt.phase === capture.phase),
        };
      }
      const turn =
        existing ??
        makeTurn(chatKey, "capture", text, false, undefined, { hostedCapture: capture });
      return promiseFor(turn, true);
    },

    hostedCaptureState(identityId, callId, phase) {
      const turn = deps.state
        .listTurns()
        .filter(
          (candidate) =>
            candidate.hostedCapture?.identityId === identityId &&
            candidate.hostedCapture.callId === callId &&
            candidate.hostedCapture.phase === phase &&
            candidate.state !== "failed" &&
            candidate.state !== "interrupted",
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!turn) return undefined;
      return turn.state === "completed" ? "completed" : "pending";
    },

    async runA2A(chatKey, text, context) {
      if (closing) return undefined;
      const existing = a2aMatch(context);
      if (existing?.state === "completed") return existing.output;
      return promiseFor(
        existing ?? makeTurn(chatKey, "capture", text, false, undefined, { a2aContext: context }),
      );
    },

    async abortA2A(chatKey, taskId) {
      const turns = deps.state
        .listTurns()
        .filter(
          (turn) =>
            turn.chatKey === chatKey &&
            turn.a2aContext?.taskId === taskId &&
            ACTIVE.has(turn.state),
        );
      for (const turn of turns) {
        deps.state.transitionTurn(turn.id, [...INTERRUPTIBLE, "delivery_started"], {
          state: "interrupted",
        });
      }
      for (const turn of turns) settle(turn.id, undefined);
      const sessionID = deps.state.getSession(chatKey);
      if (sessionID && turns.length) {
        await deps.opencode.session
          .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
          .catch(() => {});
      }
      return turns.length > 0;
    },

    async resetSession(chatKey) {
      await this.abortTurn(chatKey);
      deps.state.clearSession(chatKey);
      deps.logger.info("session.reset", { chatKey });
    },

    async abortTurn(chatKey) {
      const turns = deps.state
        .listTurns()
        .filter((turn) => turn.chatKey === chatKey && ACTIVE.has(turn.state));
      for (const turn of turns) {
        deps.state.transitionTurn(turn.id, [...INTERRUPTIBLE, "delivery_started"], {
          state: "interrupted",
        });
        settle(turn.id, undefined);
      }
      const sessionID = deps.state.getSession(chatKey);
      if (sessionID && turns.length) {
        await deps.opencode.session
          .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
          .catch(() => {});
      }
      return turns.length > 0;
    },

    status(chatKey) {
      const busy = deps.state
        .listTurns()
        .some((turn) => turn.chatKey === chatKey && ACTIVE.has(turn.state));
      return { busy, sessionID: deps.state.getSession(chatKey) };
    },

    async catchUp() {
      const recoverable = deps.state
        .listTurns()
        .filter((turn) => !TERMINAL.has(turn.state) && !turn.hostedCapture && !turn.a2aContext)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const turn of recoverable) {
        if (turn.state === "delivery_started") {
          deps.state.updateTurn(turn.id, {
            state: "failed",
            error: "Reply delivery outcome is ambiguous after restart.",
          });
        } else enqueue(turn);
      }
    },

    async close() {
      closing = true;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function extractText(res: unknown): string | undefined {
  const data = (res as any)?.data ?? res;
  const parts = data?.parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}
