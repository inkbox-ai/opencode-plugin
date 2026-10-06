import { createHash } from "node:crypto";
import type { AgentIdentity } from "@inkbox/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createStateStore, type StateStore } from "./gateway/state.js";
import type { ReplyTarget } from "./gateway/types.js";

export interface NativeSend {
  key: string;
  identityId: string;
  sourceId: string;
  conversationId: string;
  payload: string;
  state: "started" | "sent";
  messageId?: string;
}
type NativeReplyTarget = ReplyTarget & { nativeOwner?: { turnId: string; ownerId: string } };
export async function nativeTarget(
  sessionID: string,
  conversationId: string,
  context: { messageID: string; directory: string },
  client?: OpencodeClient,
  store = createStateStore(),
): Promise<NativeReplyTarget | undefined> {
  const known = store
    .listTurns()
    .filter((turn) => turn.sessionID === sessionID && turn.replyTarget?.imessageSource);
  if (!known.length) return;
  if (!client) throw new Error("Native iMessage tool ownership cannot be verified.");
  const message = await client.session.message({
    path: { id: sessionID, messageID: context.messageID },
    query: { directory: context.directory },
  });
  if (message.error || message.data?.info.role !== "assistant")
    throw new Error("Native iMessage tool source is unavailable.");
  const parentID = (message.data.info as { parentID?: string }).parentID;
  if (!parentID) throw new Error("Native iMessage tool parent is unavailable.");
  const matches = known.filter((turn) => turn.messageID === parentID);
  if (matches.length > 1) throw new Error("Native iMessage tool source is ambiguous.");
  const original = matches[0];
  if (!original) return; // An unrelated proactive turn has no inherited native source.
  const turn = store.getTurn(original.id);
  if (
    !turn ||
    turn.ownerId !== original.ownerId ||
    !["submitting", "submitted"].includes(turn.state) ||
    !turn.ownerId ||
    (turn.leaseUntil ?? 0) <= Date.now()
  )
    throw new Error("This native iMessage turn no longer owns tool sends.");
  if (turn.replyTarget?.imessageSource?.conversationId !== conversationId)
    throw new Error("Native iMessage sends must stay in the active source conversation.");
  return { ...turn.replyTarget, nativeOwner: { turnId: turn.id, ownerId: turn.ownerId } };
}
export async function sendNativeIMessage(
  identity: AgentIdentity,
  target: NativeReplyTarget,
  payload: { text?: string; mediaUrls?: string[]; sendStyle?: any },
  store: StateStore = createStateStore(),
) {
  return (await prepareNativeIMessage(identity, target, payload, store))();
}

function assertNativeOwner(target: NativeReplyTarget, store: StateStore): void {
  if (!target.nativeOwner) return;
  const current = store.getTurn(target.nativeOwner.turnId);
  if (
    !current ||
    current.ownerId !== target.nativeOwner.ownerId ||
    (current.leaseUntil ?? 0) <= Date.now() ||
    !["submitting", "submitted"].includes(current.state)
  )
    throw new Error("This native iMessage turn no longer owns tool sends.");
}

/** Read-only capability proof; fetched history must never enter model context. */
export async function preflightNativeIMessage(
  identity: AgentIdentity,
  target: NativeReplyTarget,
  store: StateStore = createStateStore(),
): Promise<void> {
  assertNativeOwner(target, store);
  const source = target.imessageSource;
  if (!source?.messageId || !source.conversationId)
    throw new Error("Native iMessage source is missing.");
  if (
    typeof identity.getIMessage !== "function" ||
    typeof identity.getIMessageThread !== "function"
  )
    throw new Error("The installed SDK does not support native iMessage reply verification.");
  const message = await identity.getIMessage(source.messageId);
  assertNativeOwner(target, store);
  if (message.conversationId !== source.conversationId)
    throw new Error("The native iMessage source belongs to a different conversation.");
  const page = await identity.getIMessageThread(source.messageId, { limit: 1 });
  assertNativeOwner(target, store);
  if (page.conversationId !== source.conversationId)
    throw new Error("Native iMessage reply support could not be verified for this conversation.");
}

/** Keep safe read failures before the caller's irreversible delivery checkpoint. */
export async function prepareNativeIMessage(
  identity: AgentIdentity,
  target: NativeReplyTarget,
  payload: { text?: string; mediaUrls?: string[]; sendStyle?: any },
  store: StateStore = createStateStore(),
) {
  await preflightNativeIMessage(identity, target, store);
  return async () => {
    const source = target.imessageSource;
    if (!source) throw new Error("Native iMessage source is missing.");
    const serialized = JSON.stringify([
      payload.text ?? "",
      payload.mediaUrls ?? [],
      payload.sendStyle ?? null,
    ]);
    const key = createHash("sha256")
      .update(JSON.stringify([identity.id, source.conversationId, source.messageId, serialized]))
      .digest("hex");
    let previous: NativeSend | undefined;
    const entry: NativeSend = {
      key,
      identityId: identity.id,
      sourceId: source.messageId,
      conversationId: source.conversationId,
      payload: serialized,
      state: "started",
    };
    store.updateIMessageSend(key, (existing) => {
      assertNativeOwner(target, store);
      previous = existing as NativeSend | undefined;
      return existing ?? entry;
    });
    if (previous?.state === "sent" && previous.messageId)
      return { id: previous.messageId, conversationId: source.conversationId, status: "sent" };
    if (previous)
      throw new Error(
        "The previous native iMessage send has an unconfirmed outcome; do not resend it.",
      );
    const message = await identity.sendIMessage({
      ...payload,
      conversationId: source.conversationId,
      replyToMessageId: source.messageId,
      plainReplyFallback: true,
      idempotencyKey: `opencode:native:${key}`,
    });
    store.updateIMessageSend(key, () => ({ ...entry, state: "sent", messageId: message.id }));
    return message;
  };
}
export function ownsNativeFailure(
  identityId: string,
  messageId?: string,
  conversationId?: string,
  store = createStateStore(),
): boolean {
  const records = Object.values((store.read().imessageSends ?? {}) as Record<string, NativeSend>);
  return records.some(
    (send) =>
      send.identityId === identityId &&
      ((messageId && send.messageId === messageId) ||
        (send.state === "started" && conversationId === send.conversationId)),
  );
}

/** Retain correlated delivery failure as context, never as a new model task. */
export function noteNativeFailure(
  identityId: string,
  messageId?: string,
  conversationId?: string,
  store = createStateStore(),
): void {
  const sends = Object.values((store.read().imessageSends ?? {}) as Record<string, NativeSend>);
  const exact = sends.filter(
    (send) => send.identityId === identityId && messageId && send.messageId === messageId,
  );
  const candidates = exact.length
    ? exact
    : sends.filter(
        (send) =>
          send.identityId === identityId &&
          send.state === "started" &&
          conversationId &&
          send.conversationId === conversationId,
      );
  // A callback can arrive before the send response. Correlate only a unique
  // durable effect; a conversation match alone must not pick an arbitrary job.
  if (candidates.length !== 1) return;
  const send = candidates[0]!;
  const owners = store
    .listTurns()
    .filter(
      (turn) =>
        turn.replyTarget?.imessageSource?.messageId === send.sourceId &&
        turn.replyTarget.imessageSource.conversationId === send.conversationId,
    );
  const keys = new Set(owners.map((turn) => turn.chatKey));
  if (keys.size !== 1) return;
  const chatKey = owners[0]!.chatKey;
  const id = `native-failure:${send.key}`;
  store.reserveTurns([
    {
      id,
      messageID: id,
      chatKey,
      kind: "capture",
      state: "context_only",
      deliver: false,
      text: "An earlier source-bound iMessage send failed. This is delivery context only, not a new request or authorization to resend its actions or message.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
}
