import { randomBytes, randomUUID } from "node:crypto";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { type ActiveA2ATurn, clearActiveA2ATurn, setActiveA2ATurn } from "../a2a-context.js";
import {
  a2aProgressSystemPrompt,
  a2aProgressUserPrompt,
  a2aToolIdentifiersFromMessages,
  cleanA2AProgress,
  fallbackA2AProgress,
} from "../a2a-progress.js";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import {
  assertCompanionSize,
  COMPANION_MAX_BYTES,
  companionChatKey,
  companionFrame,
} from "./companion.js";
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
  companionSenderAllowed?(from: string, requireReply?: boolean): Promise<boolean>;
  companionContactId?(from: string): Promise<string | undefined>;
}

const TERMINAL = new Set(["delivered", "failed", "interrupted"]);
const ACTIVE = new Set([
  "hydrating",
  "paused",
  "queued",
  "submitting",
  "submitted",
  "delivery_started",
]);
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

export function createSessionManager(
  deps: SessionManagerDeps,
): SessionManager & { acceptCompanion: NonNullable<SessionManager["acceptCompanion"]> } {
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

  async function ensureSession(chatKey: string, turn?: DurableTurn): Promise<string> {
    const sessionOwner = turn?.companion ? { turnId: turn.id, ownerId } : undefined;
    const existing = deps.state.getSession(chatKey);
    if (existing) {
      if (await sessionUsable(existing)) return existing;
      deps.state.clearSession(chatKey, sessionOwner);
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
    deps.state.setSession(chatKey, id, sessionOwner);
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
    if (turn.companion) turn = await hydrateCompanion(turn);
    if (TERMINAL.has(turn.state)) return turn;
    if (closing) throw new HostedCaptureDeferredError();
    if (turn.companion?.metadata.activation_id && !turn.companion.initialization) {
      const initializedSession = deps.state.getSession(turn.chatKey);
      if (!initializedSession || !(await sessionUsable(initializedSession))) {
        throw new Error("Companion initialized host session is unavailable; recovery is paused.");
      }
    }
    const sessionID = turn.sessionID ?? (await ensureSession(turn.chatKey, turn));
    const body = await promptBody(turn);
    if (turn.companion) assertCompanionSize(JSON.stringify(body));
    const activationId = turn.companion?.metadata.activation_id;
    if (turn.companion && activationId) {
      const c = turn.companion;
      const client = await deps.inkbox.getClient();
      const page = await client.companion.activationMessages(c.handle, activationId, {
        limit: 1,
      });
      const reply = page.replyContext;
      const expected = turn.replyTarget?.companion;
      if (
        page.scopeId !== c.metadata.scope_id ||
        page.activationId !== c.metadata.activation_id ||
        page.conversationId !== c.metadata.conversation_id ||
        page.channel !== c.metadata.channel ||
        reply.conversationId !== c.metadata.conversation_id ||
        reply.channel !== c.metadata.channel ||
        (expected &&
          JSON.stringify([reply.replyToMessageId, reply.to ?? [], reply.cc ?? []]) !==
            JSON.stringify([expected.replyToMessageId, expected.to, expected.cc]))
      ) {
        throw new Error("Companion scope changed before host submission.");
      }
    }
    if (closing) throw new HostedCaptureDeferredError();
    if (!deps.state.claimTurn(turn.id, ownerId, LEASE_MS))
      throw new Error("Durable turn lease was lost.");
    const next = deps.state.transitionTurn(
      turn.id,
      ["queued"],
      {
        state: "submitting",
        sessionID,
      },
      turn.companion ? ownerId : undefined,
    );
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
        body: body as never,
      });
      const err = (res as any)?.error;
      if (err) throw new Error(`session.promptAsync failed: ${JSON.stringify(err).slice(0, 300)}`);
      const submitted = deps.state.transitionTurn(
        turn.id,
        ["submitting"],
        {
          state: "submitted",
        },
        next.companion ? ownerId : undefined,
      );
      if (submitted) return submitted;
      const current = deps.state.getTurn(turn.id);
      if (current?.state === "interrupted") return current;
      throw new Error("Durable turn changed during submission.");
    } catch (err) {
      if (await wasAccepted(next).catch(() => false)) {
        deps.logger.warn("turn.submit_outcome_reconciled", { chatKey: next.chatKey });
        const submitted = deps.state.transitionTurn(
          turn.id,
          ["submitting"],
          {
            state: "submitted",
          },
          next.companion ? ownerId : undefined,
        );
        if (submitted) return submitted;
        const current = deps.state.getTurn(turn.id);
        if (current?.state === "interrupted") return current;
        throw new Error("Durable turn changed during submission reconciliation.");
      }
      deps.state.transitionTurn(
        turn.id,
        ["submitting"],
        {
          state: next.companion ? "paused" : "failed",
          error: String(err),
        },
        next.companion ? ownerId : undefined,
      );
      throw err;
    }
  }

  async function hydrateCompanion(turn: DurableTurn): Promise<DurableTurn> {
    const c = turn.companion;
    if (!c) return turn;
    const identity = await deps.inkbox.getIdentity();
    if (identity.id !== c.identityId || identity.agentHandle !== c.handle) {
      throw new Error("Companion identity changed; queued context is paused.");
    }
    let liveContent = c.content ?? turn.text;
    if (!c.initialization && c.mailBodyPending) {
      const message = await identity.getMessage(c.sourceId);
      if (
        message.id !== c.sourceId ||
        message.threadId !== c.metadata.conversation_id ||
        message.fromAddress.toLowerCase() !== c.from.toLowerCase()
      ) {
        throw new Error("Companion live message does not match its conversation.");
      }
      if (
        (message.bodyText == null &&
          message.bodyHtml == null &&
          !message.attachmentMetadata?.length) ||
        (message.hasAttachments && !message.attachmentMetadata?.length)
      ) {
        throw new Error("Companion mail body or attachments are unavailable.");
      }
      liveContent = JSON.stringify({
        author: message.fromAddress,
        occurredAt: message.createdAt,
        text: message.bodyText ?? message.bodyHtml ?? "",
        attachments: message.attachmentMetadata ?? [],
      });
    }
    if (c.metadata.phase === "ordinary") {
      if (!(await deps.companionSenderAllowed?.(c.from)))
        throw new Error("Companion sender is not locally permitted.");
      const contactId = await deps.companionContactId?.(c.from);
      const channel =
        c.metadata.channel === "mail"
          ? "email"
          : c.metadata.channel === "phone"
            ? "sms"
            : "imessage";
      const override = (map: Record<string, string>) =>
        (contactId ? map[contactId] : undefined) ?? map[channel];
      if (!turn.replyTarget) throw new Error("Companion ordinary reply target is missing.");
      const updated = deps.state.transitionTurn(
        turn.id,
        ["hydrating", "queued"],
        {
          agent: override(deps.config.gateway.channelAgents),
          text: companionFrame(
            `${override(deps.config.gateway.channelPrompts) ?? ""}\n${liveContent}`,
            turn.replyTarget,
          ),
        },
        ownerId,
      );
      if (!updated) throw new Error("Durable turn lease was lost.");
      return updated;
    }
    const client = await deps.inkbox.getClient();
    if (typeof client.companion?.loadInitialization !== "function") {
      throw new Error("Companion mode requires Inkbox SDK 0.7.3 or newer.");
    }
    if (!c.metadata.activation_id) throw new Error("Companion activation is missing.");
    const snapshot = await client.companion.loadInitialization(c.handle, c.metadata.activation_id, {
      maxBytes: COMPANION_MAX_BYTES,
    });
    if (closing) throw new HostedCaptureDeferredError();
    if (
      snapshot.scopeId !== c.metadata.scope_id ||
      snapshot.activationId !== c.metadata.activation_id ||
      snapshot.conversationId !== c.metadata.conversation_id ||
      snapshot.channel !== c.metadata.channel
    ) {
      throw new Error("Companion initialization does not match its conversation.");
    }
    const trigger = snapshot.entries.filter((entry) => entry.isTrigger);
    if (trigger.length !== 1 || !(await deps.companionSenderAllowed?.(trigger[0].author, true))) {
      throw new Error("Companion sponsor is not locally permitted.");
    }
    if (c.metadata.phase === "initialization" && trigger[0].id !== c.sourceId) {
      throw new Error("Companion trigger does not match the received message.");
    }
    if (!c.initialization && snapshot.entries.some((entry) => entry.id === c.sourceId)) {
      if (!deps.state.claimTurn(turn.id, ownerId, LEASE_MS))
        throw new Error("Durable turn lease was lost.");
      const duplicate = deps.state.transitionTurn(
        turn.id,
        ["hydrating", "queued"],
        { state: "delivered" },
        ownerId,
      );
      if (!duplicate) throw new Error("Durable turn lease was lost.");
      return duplicate;
    }
    const sponsorContactId = await deps.companionContactId?.(trigger[0].author);
    const localChannel =
      c.metadata.channel === "mail" ? "email" : c.metadata.channel === "phone" ? "sms" : "imessage";
    const overrides = (map: Record<string, string>) =>
      (sponsorContactId ? map[sponsorContactId] : undefined) ?? map[localChannel];
    const context = snapshot.replyContext;
    if (
      context.conversationId !== c.metadata.conversation_id ||
      context.channel !== c.metadata.channel
    ) {
      throw new Error("Companion reply scope does not match its conversation.");
    }
    const channel =
      context.channel === "mail" ? "email" : context.channel === "phone" ? "sms" : "imessage";
    const target: ReplyTarget = {
      channel,
      conversationId: context.conversationId,
      subject: c.subject,
    };
    if (channel === "email") {
      if (!context.replyToMessageId || (!context.to?.length && !context.cc?.length))
        throw new Error("Companion email reply context is incomplete.");
      target.companion = {
        replyToMessageId: context.replyToMessageId,
        to: [...(context.to ?? [])],
        cc: [...(context.cc ?? [])],
      };
    }
    if (
      turn.replyTarget &&
      JSON.stringify(turn.replyTarget.companion ?? turn.replyTarget.conversationId) !==
        JSON.stringify(target.companion ?? target.conversationId)
    ) {
      throw new Error("Companion reply audience changed; queued turn is paused.");
    }
    const text = c.initialization
      ? snapshot.text +
        (snapshot.notices?.length ? `\nNotices: ${JSON.stringify(snapshot.notices)}` : "")
      : liveContent;
    if (!deps.state.claimTurn(turn.id, ownerId, LEASE_MS))
      throw new Error("Durable turn lease was lost.");
    const next = deps.state.transitionTurn(
      turn.id,
      ["hydrating", "queued"],
      {
        state: "queued",
        text: companionFrame(
          `${overrides(deps.config.gateway.channelPrompts) ?? ""}\n${text}`,
          target,
        ),
        replyTarget: turn.replyTarget ?? target,
        agent: overrides(deps.config.gateway.channelAgents),
      },
      ownerId,
    );
    if (!next) throw new Error("Durable turn lease was lost.");
    deps.state.setReplyTarget(turn.chatKey, next.replyTarget ?? target);
    return next;
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
      const status = statuses?.[turn.sessionID]?.type;
      if (status && status !== "idle") {
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
      // A completed assistant step can still be followed by tool work or a
      // model retry. Keep the turn's side-effect guards until the final answer.
      const finish = last?.info?.finish;
      if (finish && finish !== "tool-calls" && finish !== "unknown") return extractText(last);
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
        deps.state.updateTurn(current.id, {
          state: "failed",
          error: String(err),
        });
        deps.logger.error("reply.failed", { chatKey: current.chatKey, error: String(err) });
        if (current.companion) {
          settle(current.id, output);
          return;
        }
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
    const renewal = setInterval(() => {
      try {
        deps.state.claimTurn(id, ownerId, LEASE_MS);
      } catch {
        /* Checked before submission. */
      }
    }, LEASE_MS / 3);
    renewal.unref?.();
    try {
      if (turn.state === "paused") return;
      if (turn.companion && turn.sessionID && !(await sessionUsable(turn.sessionID))) {
        throw new Error("Companion host session ownership could not be verified.");
      }
      if (turn.state === "hydrating" || turn.state === "queued") turn = await submit(turn);
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
        deps.state.transitionTurn(
          id,
          [latest.state],
          {
            state: turn.companion ? "paused" : "failed",
            error: String(err),
          },
          turn.companion ? ownerId : undefined,
        );
      }
      deps.logger.error("turn.failed", { chatKey: turn.chatKey, error: String(err) });
      if (!(leaseLost && turn.hostedCapture)) settle(id, undefined, err);
    } finally {
      clearInterval(renewal);
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
      if (
        turn.companion &&
        deps.state
          .listTurns()
          .some((candidate) => candidate.chatKey === chatKey && candidate.state === "paused")
      )
        return;
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
      if (turn.companion && deps.state.getTurn(id)?.state === "paused") return;
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
    if (turn.companion)
      entry.queue.sort((a, b) => {
        const left = deps.state.getTurn(a)?.companion;
        const right = deps.state.getTurn(b)?.companion;
        return (
          (left?.initialization ? -1 : (left?.metadata.sequence ?? 0)) -
          (right?.initialization ? -1 : (right?.metadata.sequence ?? 0))
        );
      });
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

  async function summarizeA2AProgress(
    chatKey: string,
    taskId: string,
    previousUpdate: string,
  ): Promise<string> {
    const turn = deps.state
      .listTurns()
      .filter(
        (candidate) =>
          candidate.chatKey === chatKey &&
          candidate.a2aContext?.taskId === taskId &&
          candidate.sessionID,
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    const messages = turn?.sessionID ? await listMessages(turn.sessionID).catch(() => []) : [];
    const toolIdentifiers = a2aToolIdentifiersFromMessages(messages, turn?.messageID ?? "");
    const fallback = fallbackA2AProgress();
    let sessionID: string | undefined;
    try {
      const created = await deps.opencode.session.create({
        body: { title: "Inkbox A2A progress" },
        query: { directory: deps.directory },
      });
      const createError = (created as any)?.error;
      sessionID = (created as any)?.data?.id ?? (created as any)?.id;
      if (createError || !sessionID) throw new Error("Could not create progress summary session.");
      const listed = await deps.opencode.tool.ids({ query: { directory: deps.directory } });
      const toolIds = (listed as any)?.data ?? listed;
      if (!Array.isArray(toolIds)) throw new Error("Could not restrict progress summary tools.");
      const g = deps.config.gateway;
      const request = deps.opencode.session.prompt({
        path: { id: sessionID },
        query: { directory: deps.directory },
        body: {
          system: a2aProgressSystemPrompt(),
          tools: Object.fromEntries(toolIds.map((id) => [String(id), false])),
          ...(g.model?.includes("/")
            ? {
                model: {
                  providerID: g.model.split("/")[0],
                  modelID: g.model.split("/").slice(1).join("/"),
                },
              }
            : {}),
          parts: [
            {
              type: "text",
              text: a2aProgressUserPrompt(turn?.text ?? "", toolIdentifiers, previousUpdate),
            },
          ],
        },
      });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Progress summary timed out.")), 20_000);
        timer.unref?.();
      });
      try {
        const response = await Promise.race([request, timeout]);
        const error = (response as any)?.error;
        if (error) throw new Error("Progress summary request failed.");
        return cleanA2AProgress(extractText(response), toolIdentifiers);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      deps.logger.warn("a2a.progress_summary_failed", { taskId, error: String(error) });
      return fallback;
    } finally {
      if (sessionID) {
        await deps.opencode.session
          .abort({ path: { id: sessionID }, query: { directory: deps.directory } })
          .catch(() => {});
        await deps.opencode.session
          .delete({ path: { id: sessionID }, query: { directory: deps.directory } })
          .catch(() => {});
      }
    }
  }

  return {
    ownsCompanionDelivery(channel, messageId, conversationId) {
      return deps.state
        .listTurns()
        .some(
          (turn) =>
            turn.companion &&
            turn.replyTarget?.channel === channel &&
            ((messageId && turn.deliveryMessageId === messageId) ||
              (turn.state === "delivery_started" &&
                conversationId &&
                turn.replyTarget.conversationId === conversationId)),
        );
    },
    async acceptCompanion(companion, text, target) {
      if (closing) throw new Error("Gateway is closing; retry Companion delivery.");
      const chatKey = companionChatKey(companion.identityId, companion.metadata);
      const candidates: DurableTurn[] = [];
      if (companion.metadata.activation_id) {
        candidates.push(
          makeTurn(chatKey, "capture", "", true, undefined, {
            id: `${chatKey}:initialization`,
            state: "hydrating",
            companion: { ...companion, initialization: true },
          }),
        );
      }
      if (companion.metadata.phase !== "initialization") {
        candidates.push(
          makeTurn(
            chatKey,
            "capture",
            companionFrame(
              text,
              target ?? {
                channel:
                  companion.metadata.channel === "mail"
                    ? "email"
                    : companion.metadata.channel === "phone"
                      ? "sms"
                      : "imessage",
                conversationId: companion.metadata.conversation_id,
              },
            ),
            true,
            target,
            {
              id: `${chatKey}:event:${companion.sourceId}`,
              companion: { ...companion, initialization: false, content: text },
              state: companion.metadata.activation_id ? "hydrating" : "queued",
            },
          ),
        );
      }
      const reserved = deps.state.reserveTurns(candidates);
      for (const turn of reserved)
        if (!TERMINAL.has(turn.state) && turn.state !== "completed") enqueue(turn);
    },
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

    summarizeA2AProgress,

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
