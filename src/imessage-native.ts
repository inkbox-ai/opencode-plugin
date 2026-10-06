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
  const original = known.find(
    (turn) => turn.messageID === (message.data!.info as { parentID?: string }).parentID,
  );
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
  return turn.replyTarget?.imessageSource?.conversationId === conversationId
    ? { ...turn.replyTarget, nativeOwner: { turnId: turn.id, ownerId: turn.ownerId } }
    : undefined;
}
export async function sendNativeIMessage(
  identity: AgentIdentity,
  target: NativeReplyTarget,
  payload: { text?: string; mediaUrls?: string[]; sendStyle?: any },
  store: StateStore = createStateStore(),
) {
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
    if (target.nativeOwner) {
      const current = store.getTurn(target.nativeOwner.turnId);
      if (
        !current ||
        current.ownerId !== target.nativeOwner.ownerId ||
        (current.leaseUntil ?? 0) <= Date.now() ||
        !["submitting", "submitted"].includes(current.state)
      )
        throw new Error("This native iMessage turn no longer owns tool sends.");
    }
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
