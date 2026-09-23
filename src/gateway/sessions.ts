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
import { prepareReply, ReplyPreparationError } from "./reply.js";
import { companionWakes, mentionsAgent, sameAuthor } from "./response-policy.js";
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
  companionLocalAllowed?(
    from: string,
    contactId: string | undefined,
    requireReply: boolean,
  ): boolean;
  companionControl?(
    turn: import("./companion.js").CompanionTurn,
    chatKey: string,
    target: ReplyTarget,
  ): Promise<boolean>;
}

const TERMINAL = new Set(["delivered", "failed", "interrupted", "context_only"]);
const ACTIVE = new Set([
  "hydrating",
  "paused",
  "queued",
  "submitting",
  "submitted",
  "completed",
  "delivery_started",
]);
const INTERRUPTIBLE = ["queued", "submitting", "submitted"] as const;
const POLL_MS = 250;
const LEASE_MS = 60_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMessageSequence = 0n;

function retryableRead(error: unknown): boolean {
  const err = error as {
    status?: number;
    statusCode?: number;
    status_code?: number;
    name?: string;
    code?: string;
    cause?: { code?: string };
  } | null;
  const status = err?.status ?? err?.statusCode ?? err?.status_code;
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500 && status < 600) ||
    ["TimeoutError", "AbortError", "NetworkError", "InkboxConnectionError"].includes(
      err?.name ?? "",
    ) ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(err?.code ?? err?.cause?.code ?? "")
  );
}

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
  const generations = new Map<string, number>();

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
    const res = await deps.opencode.session.get({
      path: { id },
      query: { directory: deps.directory },
    });
    if ((res as any)?.error) {
      if ((res as any)?.response?.status === 404) return false;
      throw new Error("Could not resume the saved host session; retrying without clearing it.");
    }
    const dir = (res as any)?.data?.directory;
    return dir === undefined || dir === deps.directory;
  }

  async function ensureSession(chatKey: string, turn: DurableTurn): Promise<string> {
    const generation = generations.get(chatKey) ?? 0;
    const check = () => {
      if (
        closing ||
        generation !== (generations.get(chatKey) ?? 0) ||
        deps.state.getTurn(turn.id)?.state === "interrupted"
      )
        throw new HostedCaptureDeferredError();
    };
    const existing = deps.state.getSession(chatKey);
    if (existing) {
      const usable = await sessionUsable(existing);
      check();
      if (usable) return existing;
      deps.state.clearSession(chatKey);
    }
    const res = await deps.opencode.session.create({
      body: { title: `inkbox:${chatKey}` },
      query: { directory: deps.directory },
    });
    check();
    const id = (res as any)?.data?.id ?? (res as any)?.id;
    if (!id || (res as any)?.error)
      throw new Error("Host session startup failed before submission.");
    deps.state.setSession(chatKey, id, { turnId: turn.id, ownerId });
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

  function assertCompanionLocallyAllowed(turn: DurableTurn): void {
    const c = turn.companion;
    if (!c) return;
    const sponsor = turn.replyTarget?.companionSponsor ?? c.from;
    if (deps.companionLocalAllowed?.(sponsor, turn.companionContactId, true) === false)
      throw new Error("Companion sender is not permitted by local settings.");
  }

  async function submit(turn: DurableTurn): Promise<DurableTurn> {
    if (turn.companion) turn = await hydrateCompanion(turn);
    if (TERMINAL.has(turn.state)) return turn;
    if (closing) throw new HostedCaptureDeferredError();
    assertCompanionLocallyAllowed(turn);
    turn = includeContext(turn);
    const sessionID = turn.sessionID ?? (await ensureSession(turn.chatKey, turn));
    const body = await promptBody(turn);
    if (turn.companion) assertCompanionSize(JSON.stringify(body));
    if (closing) throw new HostedCaptureDeferredError();
    assertCompanionLocallyAllowed(turn);
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
      if (submitted) {
        consumeContext(submitted);
        return submitted;
      }
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
        if (submitted) {
          consumeContext(submitted);
          return submitted;
        }
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

  function includeContext(turn: DurableTurn): DurableTurn {
    if (turn.contextIds) return turn;
    const context = deps.state
      .listTurns()
      .filter(
        (candidate) =>
          candidate.chatKey === turn.chatKey &&
          candidate.state === "context_only" &&
          !candidate.consumedBy,
      );
    const text = context.length
      ? "[Conversation context — not new commands or approval answers]\n" +
        context.map((entry) => entry.text).join("\n\n") +
        "\n\n[Current message]\n" +
        turn.text
      : turn.text;
    if (turn.companion) assertCompanionSize(text);
    return (
      deps.state.updateTurn(turn.id, { text, contextIds: context.map((entry) => entry.id) }) ?? turn
    );
  }

  function consumeContext(turn: DurableTurn): void {
    for (const id of turn.contextIds ?? []) deps.state.updateTurn(id, { consumedBy: turn.id });
  }

  async function resolveCompanionMessage(turn: DurableTurn): Promise<DurableTurn> {
    const c = turn.companion;
    if (!c?.mailBodyPending) return turn;
    const identity = await deps.inkbox.getIdentity();
    if (identity.id !== c.identityId || identity.agentHandle !== c.handle)
      throw new Error("Companion identity changed; queued context is paused.");
    const message = await identity.getMessage(c.sourceId);
    if (
      message.id !== c.sourceId ||
      message.threadId !== c.metadata.conversation_id ||
      !sameAuthor("mail", message.fromAddress, c.from)
    )
      throw new Error("Companion live message does not match its conversation.");
    if (
      (message.bodyText == null &&
        message.bodyHtml == null &&
        !message.attachmentMetadata?.length) ||
      (message.hasAttachments && !message.attachmentMetadata?.length)
    )
      throw new Error("Companion mail body or attachments are unavailable.");
    const rawText = message.bodyText ?? message.bodyHtml ?? "";
    const content = JSON.stringify({
      author: c.from,
      text: rawText,
      attachments: message.attachmentMetadata ?? [],
      sender_access: c.senderAccess,
    });
    assertCompanionSize(content);
    const latest = deps.state.getTurn(turn.id);
    if (latest?.state !== "hydrating") return latest ?? turn;
    return (
      deps.state.updateTurn(turn.id, {
        companion: { ...c, rawText, content, mailBodyPending: false },
      }) ?? turn
    );
  }

  async function hydrateCompanion(turn: DurableTurn): Promise<DurableTurn> {
    turn = await resolveCompanionMessage(turn);
    const c = turn.companion;
    if (!c || c.hydrated || TERMINAL.has(turn.state)) return turn;
    const identity = await deps.inkbox.getIdentity();
    if (identity.id !== c.identityId || identity.agentHandle !== c.handle)
      throw new Error("Companion identity changed; queued context is paused.");
    let liveContent = c.content ?? turn.text;
    const channel =
      c.metadata.channel === "mail" ? "email" : c.metadata.channel === "phone" ? "sms" : "imessage";
    let target = turn.replyTarget;
    let sponsor = c.from;
    let history = deps.state.getTurn(`${turn.chatKey}:history`);
    if (c.metadata.phase === "ordinary") {
      if (!(await deps.companionSenderAllowed?.(c.from)))
        return deps.state.updateTurn(turn.id, { state: "delivered" }) ?? turn;
      target ??= {
        channel,
        conversationId: c.metadata.conversation_id,
        messageId: c.sourceId,
        sender: c.from,
      };
    } else {
      if (!c.metadata.activation_id) throw new Error("Companion activation is missing.");
      if (!history) {
        const client = await deps.inkbox.getClient();
        const snapshot = await client.companion.loadInitialization(
          c.handle,
          c.metadata.activation_id,
          { maxBytes: COMPANION_MAX_BYTES },
        );
        if (closing) throw new HostedCaptureDeferredError();
        if (
          snapshot.scopeId !== c.metadata.scope_id ||
          snapshot.activationId !== c.metadata.activation_id ||
          snapshot.conversationId !== c.metadata.conversation_id ||
          snapshot.channel !== c.metadata.channel
        )
          throw new Error("Companion initialization does not match its conversation.");
        const triggers = snapshot.entries.filter((entry) => entry.isTrigger);
        if (
          triggers.length !== 1 ||
          triggers[0].historical !== false ||
          !(await deps.companionSenderAllowed?.(triggers[0].author, true))
        )
          throw new Error("Companion sponsor is not locally permitted.");
        const trigger = triggers[0];
        if (c.metadata.phase === "initialization" && trigger.id !== c.sourceId)
          throw new Error("Companion trigger does not match the received message.");
        if (
          snapshot.entries.some(
            (entry) => entry.id === c.sourceId && !sameAuthor(channel, entry.author, c.from),
          )
        )
          throw new Error("Companion snapshot author does not match the received message.");
        const context = snapshot.replyContext;
        if (
          context.channel !== c.metadata.channel ||
          context.conversationId !== c.metadata.conversation_id
        )
          throw new Error("Companion reply scope does not match its conversation.");
        target = {
          channel,
          conversationId: context.conversationId,
          subject: c.subject,
          sender: trigger.author,
          companionSponsor: trigger.author,
        };
        if (channel === "email") {
          if (
            context.replyToMessageId !== trigger.id ||
            (!context.to?.length && !context.cc?.length)
          )
            throw new Error("Companion email reply context is incomplete.");
          target.companion = {
            replyToMessageId: context.replyToMessageId,
            to: [...(context.to ?? [])],
            cc: [...(context.cc ?? [])],
          };
        }
        const snapshotText =
          snapshot.text +
          (snapshot.notices?.length ? `\nNotices: ${JSON.stringify(snapshot.notices)}` : "");
        if (
          !deps.state.claimTurn(turn.id, ownerId, LEASE_MS) ||
          deps.state.getTurn(turn.id)?.state === "interrupted"
        )
          throw new Error("Durable turn lease was lost.");
        history = deps.state.reserveTurns([
          makeTurn(turn.chatKey, "capture", snapshotText, false, target, {
            id: `${turn.chatKey}:history`,
            state: "context_only",
            historySourceIds: snapshot.entries.map((entry) => entry.id),
            historyTriggerId: trigger.id,
            companion: { ...c, hydrated: true },
          }),
        ])[0];
      }
      if (c.metadata.phase === "initialization" && history.historyTriggerId !== c.sourceId)
        throw new Error("A new Companion trigger requires a new activation.");
      target = history.replyTarget;
      sponsor = target?.companionSponsor ?? "";
      // Later delivery of a source already included in the initialization is
      // not another current message. The receipt that seeded history is exempt.
      if (
        history.companion?.sourceId !== c.sourceId &&
        history.historySourceIds?.includes(c.sourceId)
      )
        return deps.state.updateTurn(turn.id, { state: "delivered" }) ?? turn;
      if (history.historySourceIds?.includes(c.sourceId))
        liveContent = `Current receipt: ${c.sourceId}; sender_access=${c.senderAccess ?? "unknown"}. Its message is in the initialization above.`;
    }
    if (!target) throw new Error("Companion reply target is unavailable.");
    target = { ...target, sender: c.from, companionMode: true, group: true };
    const contactId = history?.companionPolicyReady
      ? history.companionContactId
      : await deps.companionContactId?.(sponsor);
    if (history && !history.companionPolicyReady)
      deps.state.updateTurn(history.id, {
        companionContactId: contactId,
        companionPolicyReady: true,
      });
    const override = (map: Record<string, string>) =>
      (contactId ? map[contactId] : undefined) ?? map[channel];
    const wakes = companionWakes(c, deps.config.gateway);
    const text = companionFrame(
      `${override(deps.config.gateway.channelPrompts) ?? ""}\n${liveContent}`,
      target,
    );
    const next = deps.state.transitionTurn(
      turn.id,
      ["hydrating", "queued"],
      {
        state: wakes ? "queued" : "context_only",
        companionContactId: contactId,
        companionPolicyReady: true,
        wake: wakes,
        text,
        replyTarget: target,
        agent: override(deps.config.gateway.channelAgents),
        companion: { ...c, hydrated: true },
      },
      ownerId,
    );
    if (!next) throw new Error("Durable turn lease was lost.");
    if (wakes) assertCompanionLocallyAllowed(next);
    if (
      wakes &&
      c.metadata.phase !== "initialization" &&
      !next.controlHandled &&
      (await deps.companionControl?.(c, turn.chatKey, target))
    )
      return deps.state.updateTurn(turn.id, { state: "delivered", controlHandled: true }) ?? turn;
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

  function recoverReply(turn: DurableTurn, error: unknown, output: string): void {
    const target = turn.replyTarget;
    if (!target) return;
    const recovery = deliveryFailureRecovery({
      key: deliveryFailureKey(target.channel, target.to, target.conversationId),
      channel: target.channel,
      target: target.to,
      failure: error,
      failedBody: output,
    });
    if (recovery.prompt) enqueue(makeTurn(turn.chatKey, "normal", recovery.prompt, true, target));
  }

  async function finish(turn: DurableTurn, output: string | undefined): Promise<void> {
    if (closing) return;
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
      assertCompanionLocallyAllowed(current);
      let send: Awaited<ReturnType<typeof prepareReply>>;
      try {
        send = await prepareReply(deps.inkbox, current.replyTarget, output, deps.logger);
      } catch (error) {
        if (!(error instanceof ReplyPreparationError)) throw error;
        deps.state.updateTurn(current.id, {
          state: current.companion ? "paused" : "failed",
          error: String(error),
        });
        if (!current.companion) recoverReply(current, error, output);
        settle(current.id, output);
        return;
      }
      if (closing || deps.state.getTurn(current.id)?.state === "interrupted") return;
      if (
        !deps.state.transitionTurn(
          current.id,
          ["completed"],
          { state: "delivery_started" },
          ownerId,
        )
      )
        throw new Error("Durable turn lease was lost.");
      try {
        const sent = await send();
        deps.state.updateTurn(current.id, {
          state: "delivered",
          deliveryMessageId: sent.messageId,
        });
      } catch (err) {
        deps.state.updateTurn(current.id, {
          state: current.companion ? "paused" : "failed",
          error: String(err),
        });
        deps.logger.error("reply.failed", { chatKey: current.chatKey, error: String(err) });
        if (current.companion) {
          settle(current.id, output);
          return;
        }
        recoverReply(current, err, output);
      }
    }
    if (current.deliver && output === undefined)
      deps.state.updateTurn(current.id, { state: "delivered" });
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
      if (turn.state === "hydrating" || turn.state === "queued") turn = await submit(turn);
      else if (turn.state === "submitting") {
        if (!(await wasAccepted(turn))) throw new Error("Prompt submission outcome is ambiguous.");
        turn =
          deps.state.transitionTurn(id, ["submitting"], { state: "submitted" }) ??
          deps.state.getTurn(id) ??
          turn;
      }
      if (turn.state === "submitted" && turn.sessionID) {
        consumeContext(turn);
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
          state: turn.companion ? "paused" : "failed",
          error: "Reply delivery outcome is ambiguous after restart.",
        });
      }
    } catch (err) {
      const latest = deps.state.getTurn(id);
      if (latest?.state === "interrupted") {
        settle(id, undefined);
        return;
      }
      const leaseLost = String(err).includes("Durable turn lease was lost");
      if (
        !closing &&
        !leaseLost &&
        latest &&
        ["hydrating", "queued", "completed", "submitted"].includes(latest.state)
      ) {
        const retryCount = (latest.retryCount ?? 0) + 1;
        if (retryCount > 5 && !retryableRead(err)) {
          deps.state.updateTurn(id, {
            retryCount,
            retryAt: undefined,
            state: latest.companion ? "paused" : "failed",
            error: String(err),
          });
          settle(id, undefined, err);
          return;
        }
        const retryAt = Date.now() + Math.min(60_000, POLL_MS * 2 ** Math.min(retryCount - 1, 8));
        deps.state.updateTurn(id, { retryCount, retryAt, error: String(err) });
        const timer = setTimeout(() => {
          const pending = deps.state.getTurn(id);
          if (!closing && pending) enqueue(pending);
        }, retryAt - Date.now());
        timer.unref?.();
        deps.logger.warn("turn.retry_pending", { chatKey: turn.chatKey, state: latest.state });
        return;
      }
      if (!closing && !leaseLost && latest && !TERMINAL.has(latest.state))
        deps.state.updateTurn(id, {
          state: turn.companion ? "paused" : "failed",
          error: String(err),
        });
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
      if (closing) return;
      if (turn.retryAt && turn.retryAt > Date.now()) {
        entry.queue.unshift(id);
        const timer = setTimeout(() => void drain(chatKey), turn.retryAt - Date.now());
        timer.unref?.();
        return;
      }
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
      const latest = deps.state.getTurn(id);
      if (latest?.state === "paused") return;
      if (latest?.retryAt && latest.retryAt > Date.now()) {
        entry.queue.unshift(id);
        return;
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
      const chatKey = companionChatKey(
        companion.identityId,
        companion.metadata,
        companion.environment ?? deps.config.baseUrl,
      );
      const candidate = makeTurn(chatKey, "capture", text, true, target, {
        id: `${chatKey}:event:${companion.sourceId}`,
        state: "hydrating",
        companion: { ...companion, content: text },
      });
      const existing = deps.state.getTurn(candidate.id);
      if (existing && existing.state !== "hydrating") return;
      let turn = existing ?? deps.state.reserveTurns([candidate])[0];
      companion = turn.companion ?? companion;
      const history = deps.state.getTurn(`${chatKey}:history`);
      if (
        history?.historySourceIds?.includes(companion.sourceId) &&
        history.companion?.sourceId !== companion.sourceId
      ) {
        deps.state.updateTurn(turn.id, { state: "delivered" });
        return;
      }
      const controlTarget =
        history?.replyTarget ?? (companion.metadata.phase === "ordinary" ? target : undefined);
      if (
        controlTarget &&
        companion.metadata.phase !== "initialization" &&
        companion.mailBodyPending &&
        deps.state
          .listTurns()
          .some(
            (pending) =>
              pending.chatKey === chatKey && ["submitted", "submitting"].includes(pending.state),
          )
      ) {
        try {
          turn = await resolveCompanionMessage(turn);
          companion = turn.companion ?? companion;
        } catch (error) {
          enqueue(turn);
          throw error;
        }
        if (turn.state !== "hydrating") return;
      }
      if (
        controlTarget &&
        companion.metadata.phase !== "initialization" &&
        companionWakes(companion, deps.config.gateway) &&
        deps.companionLocalAllowed?.(
          controlTarget.companionSponsor ?? companion.from,
          history?.companionContactId ??
            (companion.metadata.phase === "ordinary"
              ? await deps.companionContactId?.(companion.from)
              : undefined),
          true,
        ) !== false &&
        (await deps.companionControl?.(companion, chatKey, {
          ...controlTarget,
          sender: companion.from,
        }))
      ) {
        deps.state.updateTurn(turn.id, { state: "delivered", controlHandled: true });
        return;
      }
      enqueue(turn);
    },
    async handleInbound(msg: InboundMessage) {
      if (closing) return;
      const target: ReplyTarget = {
        channel: msg.channel,
        to: msg.from,
        conversationId: msg.conversationId,
        subject: msg.subject,
        rfcMessageId: msg.rfcMessageId,
        messageId: msg.messageId,
        sender: msg.from,
        group: Boolean(msg.group) && (msg.channel !== "email" || !msg.contactId),
      };

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
      if (msg.group && msg.channel !== "email" && g.groupReplyMode === "mention") {
        const identity = await deps.inkbox.getIdentity();
        if (msg.reaction || !mentionsAgent(msg.rawText ?? msg.text, identity.agentHandle)) {
          deps.state.saveTurn({ ...turn, state: "context_only", deliver: false });
          return;
        }
      }
      deps.state.setReplyTarget(msg.chatKey, target);
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
      return promiseFor(
        makeTurn(chatKey, "capture", text, false, deps.state.getReplyTarget(chatKey)),
      );
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
        makeTurn(chatKey, "capture", text, false, deps.state.getReplyTarget(chatKey), {
          hostedCapture: capture,
        });
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
        deps.state.transitionTurn(
          turn.id,
          ["hydrating", "paused", "completed", ...INTERRUPTIBLE, "delivery_started"],
          {
            state: "interrupted",
          },
        );
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
      generations.set(chatKey, (generations.get(chatKey) ?? 0) + 1);
      await this.abortTurn(chatKey);
      deps.state.clearSession(chatKey);
      for (const context of deps.state.listTurns()) {
        if (context.chatKey === chatKey && context.state === "context_only" && !context.consumedBy)
          deps.state.updateTurn(context.id, { consumedBy: "session-reset" });
      }
      deps.logger.info("session.reset", { chatKey });
    },

    async abortTurn(chatKey) {
      const turns = deps.state
        .listTurns()
        .filter((turn) => turn.chatKey === chatKey && ACTIVE.has(turn.state));
      for (const turn of turns) {
        deps.state.transitionTurn(
          turn.id,
          ["hydrating", "paused", "completed", ...INTERRUPTIBLE, "delivery_started"],
          {
            state: "interrupted",
          },
        );
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
            state: turn.companion ? "paused" : "failed",
            error: "Reply delivery outcome is ambiguous after restart.",
          });
        } else enqueue(turn);
      }
    },

    async close() {
      closing = true;
      for (const turn of deps.state.listTurns()) {
        if (turn.ownerId === ownerId && turn.state !== "delivery_started")
          deps.state.updateTurn(turn.id, { ownerId: undefined, leaseUntil: 0 });
      }
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
