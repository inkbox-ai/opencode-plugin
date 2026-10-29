import { createHash } from "node:crypto";
import type { AgentIdentity } from "@inkbox/sdk";
import { createStateStore, type StateStore } from "./gateway/state.js";
import type { InboundMessage, ReplyTarget } from "./gateway/types.js";
import type { HostClient } from "./host/types.js";

export const WHATSAPP_EVENTS = [
  "whatsapp.received",
  "whatsapp.reaction_received",
  "whatsapp.sent",
  "whatsapp.delivered",
  "whatsapp.delivery_failed",
  "whatsapp.delivery_unconfirmed",
];
export const WHATSAPP_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const rejectedSendCodes: Record<number, readonly string[]> = {
  403: [
    "whatsapp_not_eligible",
    "whatsapp_access_required",
    "whatsapp_contact_not_allowed",
    "whatsapp_media_source_not_allowed",
  ],
  409: [
    "whatsapp_capability_not_ready",
    "whatsapp_quote_unavailable",
    "whatsapp_membership_unresolved",
    "whatsapp_group_unavailable",
    "whatsapp_reaction_pending",
    "whatsapp_reaction_target_unavailable",
  ],
  413: ["whatsapp_media_too_large"],
  422: [
    "whatsapp_groups_not_supported",
    "whatsapp_invalid_recipient",
    "whatsapp_text_too_long",
    "whatsapp_unanswered_followup_limit",
    "whatsapp_opening_message_too_long",
    "whatsapp_reply_required_for_media",
    "whatsapp_reply_required_for_links",
    "whatsapp_reply_required_for_phone_numbers",
    "whatsapp_reply_required_for_email_addresses",
  ],
  429: [
    "whatsapp_daily_limit_exceeded",
    "whatsapp_new_group_limit",
    "whatsapp_group_unanswered_limit",
    "whatsapp_unanswered_message_limit",
    "whatsapp_conversation_rate_limited",
    "whatsapp_new_contact_rate_limited",
    "whatsapp_new_contact_spacing",
    "whatsapp_follow_up_rate_limited",
  ],
};
export type WhatsAppOwner = ReplyTarget & { nativeOwner?: { turnId: string; ownerId: string } };

export function assertWhatsAppOwner(
  target: WhatsAppOwner | undefined,
  store = createStateStore(),
): void {
  if (!target?.nativeOwner) return;
  const turn = store.getTurn(target.nativeOwner.turnId);
  if (
    !turn ||
    turn.ownerId !== target.nativeOwner.ownerId ||
    (turn.leaseUntil ?? 0) <= Date.now() ||
    !["submitting", "submitted"].includes(turn.state)
  )
    throw new Error("The originating turn no longer owns WhatsApp operations.");
}

export async function whatsappToolOwner(
  sessionID: string,
  context: { messageID: string; directory: string },
  host?: HostClient,
  store = createStateStore(),
): Promise<WhatsAppOwner | undefined> {
  const known = store
    .listTurns()
    .filter(
      (turn) =>
        turn.sessionID === sessionID &&
        (turn.replyTarget?.whatsappSource ||
          turn.replyTarget?.imessageSource ||
          turn.replyTarget?.slack ||
          turn.companion),
    );
  if (!known.length) return;
  if (!host) throw new Error("The originating tool source cannot be verified.");
  const result = await host.session.message({
    path: { id: sessionID, messageID: context.messageID },
    query: { directory: context.directory },
  });
  const info = result.data?.info;
  if (result.error || info?.role !== "assistant" || !(info as { parentID?: string }).parentID)
    throw new Error("The originating tool parent is unavailable.");
  const matches = known.filter(
    (turn) => turn.messageID === (info as { parentID?: string }).parentID,
  );
  if (!matches.length) return;
  if (matches.length !== 1 || !matches[0].replyTarget || !matches[0].ownerId)
    throw new Error("The originating tool source is ambiguous.");
  const owner = {
    ...matches[0].replyTarget,
    nativeOwner: { turnId: matches[0].id, ownerId: matches[0].ownerId },
  };
  assertWhatsAppOwner(owner, store);
  return owner;
}

export function assertWhatsAppText(text: string): void {
  if ([...text].length > 4000)
    throw new Error(
      "WhatsApp text must be at most 4,000 characters; current server limits can be lower.",
    );
}

export async function prepareWhatsApp(
  identity: AgentIdentity,
  target: WhatsAppOwner,
  payload: { text?: string; mediaIds?: string[]; replyToMessageId?: string; groupName?: string },
  store = createStateStore(),
  originalKey?: string,
  inheritSourceQuote = true,
) {
  if (typeof identity.sendWhatsApp !== "function")
    throw new Error("WhatsApp requires Inkbox SDK 0.7.24 or newer.");
  assertWhatsAppText(payload.text ?? "");
  const source = target.whatsappSource;
  const destination =
    (target as WhatsAppOwner & { whatsappRecipients?: string[] }).whatsappRecipients ?? target.to;
  if (!(target.conversationId || destination) || (source && source.identityId !== identity.id))
    throw new Error("The original WhatsApp identity or conversation changed.");
  assertWhatsAppOwner(target, store);
  const keyFor = (body: typeof payload) =>
    `opencode:whatsapp:${createHash("sha256")
      .update(
        JSON.stringify([
          identity.id,
          target.conversationId ?? destination,
          source?.messageId ?? target.messageId,
          body,
        ]),
      )
      .digest("hex")}`;
  // A saved plain intent must keep its original body and key after an upgrade.
  const legacyKey = originalKey ?? keyFor(payload);
  const sends = (store.read().whatsappSends ?? {}) as Record<string, any>;
  const saved = sends[legacyKey];
  const savedPayload =
    saved && typeof saved.payload === "string"
      ? (JSON.parse(saved.payload) as typeof payload)
      : undefined;
  if (!payload.replyToMessageId && originalKey && savedPayload?.replyToMessageId) {
    payload = { ...payload, replyToMessageId: savedPayload.replyToMessageId };
  } else if (
    !saved &&
    inheritSourceQuote &&
    !payload.replyToMessageId &&
    source?.autoReplyTarget === source?.messageId &&
    source?.autoReplyTarget &&
    !source.reactionId &&
    target.conversationId
  ) {
    payload = { ...payload, replyToMessageId: source.autoReplyTarget };
  }
  const idempotencyKey = saved ? legacyKey : (originalKey ?? keyFor(payload));
  return async () => {
    assertWhatsAppOwner(target, store);
    const priorQuote = Object.values(store.read().whatsappSends ?? {}).find(
      (send: any) =>
        source &&
        send.sourceId === source.messageId &&
        send.identityId === identity.id &&
        send.conversationId === target.conversationId &&
        send.quoteAttempt &&
        ["started", "rejected"].includes(send.state) &&
        send.idempotencyKey !== idempotencyKey,
    );
    if (priorQuote)
      throw new Error(
        "The source has an unresolved quoted send; retain its original key and payload.",
      );
    let previous: any;
    const entry = {
      identityId: identity.id,
      sourceId: source?.messageId ?? target.messageId,
      conversationId: target.conversationId,
      to: destination,
      explicit: Boolean(originalKey),
      ...(originalKey && payload.replyToMessageId ? { quoteAttempt: true } : {}),
      payload: JSON.stringify(payload),
      idempotencyKey,
      state: "started",
    };
    store.updateWhatsAppSend(idempotencyKey, (existing) => {
      previous = existing;
      const old = existing as typeof entry | undefined;
      if (
        old &&
        (old.payload !== entry.payload ||
          old.identityId !== entry.identityId ||
          old.conversationId !== entry.conversationId ||
          JSON.stringify(old.to) !== JSON.stringify(entry.to))
      )
        throw new Error("The original WhatsApp key belongs to a different payload or destination.");
      return (old as { state?: string } | undefined)?.state === "rejected"
        ? entry
        : (existing ?? entry);
    });
    if (
      previous &&
      (previous.payload !== entry.payload ||
        previous.identityId !== entry.identityId ||
        previous.conversationId !== entry.conversationId ||
        JSON.stringify(previous.to) !== JSON.stringify(entry.to))
    )
      throw new Error("The original WhatsApp key belongs to a different payload or destination.");
    if (previous?.state === "sent" && previous.messageId)
      return { id: previous.messageId, conversationId: target.conversationId };
    if (previous && previous.state !== "rejected")
      throw new Error(
        `WhatsApp outcome is unconfirmed; use inkbox_lookup_whatsapp_send with idempotencyKey=${idempotencyKey}, mediaId=${payload.mediaIds?.[0] ?? "none"}; do not resend.`,
      );
    try {
      assertWhatsAppOwner(target, store);
      const message = await identity.sendWhatsApp({
        ...payload,
        ...(target.conversationId
          ? { conversationId: target.conversationId }
          : { to: destination }),
        idempotencyKey,
      });
      store.updateWhatsAppSend(idempotencyKey, () => ({
        ...entry,
        state: "sent",
        messageId: message.id,
      }));
      return message;
    } catch (error) {
      const policy = publicWhatsAppPolicy(error);
      if (policy) {
        store.updateWhatsAppSend(idempotencyKey, () => ({ ...entry, state: "rejected", policy }));
        const rejected = new Error(
          `WhatsApp request not accepted: ${JSON.stringify(policy)}. Follow retry_condition; retain the original key and owned media ID.`,
        );
        Object.assign(rejected, {
          whatsappPolicy: policy,
          idempotencyKey,
          mediaId: payload.mediaIds?.[0] ?? null,
        });
        throw rejected;
      }
      throw new Error(
        `WhatsApp send not confirmed; preserve idempotencyKey=${idempotencyKey}, mediaId=${payload.mediaIds?.[0] ?? "none"} and use inkbox_lookup_whatsapp_send. Do not upload or send a new copy. ${error instanceof Error && "statusCode" in error ? `HTTP ${error.statusCode}` : ""}`,
      );
    }
  };
}

export function recordWhatsAppStatus(
  message: Record<string, unknown>,
  identityId: string,
  store: StateStore,
): void {
  if (
    message.agent_identity_id !== identityId ||
    message.direction !== "outbound" ||
    typeof message.id !== "string" ||
    typeof message.updated_at !== "string"
  )
    return;
  const time = Date.parse(message.updated_at);
  if (!Number.isFinite(time)) return;
  store.updateWhatsAppSend(`status:${identityId}:${message.id}`, (old) => {
    const prior = old as Record<string, unknown> | undefined;
    if (prior && Date.parse(String(prior.updatedAt)) > time) return prior;
    return {
      identityId,
      messageId: message.id,
      conversationId: message.conversation_id,
      status: message.status,
      deliveryState: message.delivery_state,
      updatedAt: message.updated_at,
    };
  });
}

export function hasExplicitWhatsAppReply(
  target: ReplyTarget | undefined,
  store: StateStore,
): boolean {
  if (!target?.whatsappSource) return false;
  return Object.values((store.read().whatsappSends ?? {}) as Record<string, any>).some(
    (send) =>
      send.explicit &&
      send.sourceId === target.whatsappSource!.messageId &&
      send.identityId === target.whatsappSource!.identityId &&
      send.conversationId === target.conversationId &&
      (["started", "sent"].includes(send.state) || send.quoteAttempt === true),
  );
}

/** Forward only the documented public policy envelope, not arbitrary provider bodies. */
export function publicWhatsAppPolicy(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return;
  const original = error as {
    detail?: unknown;
    whatsappPolicy?: Record<string, unknown>;
    retryAfterSeconds?: unknown;
    statusCode?: unknown;
  };
  if (original.whatsappPolicy)
    return publicWhatsAppPolicy({
      statusCode: original.whatsappPolicy.status_code,
      detail: original.whatsappPolicy,
      retryAfterSeconds: original.whatsappPolicy.retry_after_seconds,
    });
  const detail = original.detail;
  if (!detail || typeof detail !== "object") return;
  const row = detail as Record<string, unknown>;
  if (
    typeof row.error !== "string" ||
    !rejectedSendCodes[Number(original.statusCode)]?.includes(row.error)
  )
    return;
  const result: Record<string, unknown> = { error: row.error };
  if (typeof row.quota === "string" && /^whatsapp\.[a-z0-9_.]{1,120}$/.test(row.quota))
    result.quota = row.quota;
  for (const key of ["limit", "used"]) if (Number.isInteger(row[key])) result[key] = row[key];
  if (typeof row.retry_condition === "string")
    result.retry_condition = row.retry_condition.slice(0, 1000);
  if (typeof row.reset_at === "string" && /^[0-9T:.+Z-]{20,40}$/.test(row.reset_at))
    result.reset_at = row.reset_at;
  if (Number.isInteger(original.retryAfterSeconds) && Number(original.retryAfterSeconds) >= 0)
    result.retry_after_seconds = original.retryAfterSeconds;
  if (Number.isInteger(original.statusCode)) result.status_code = original.statusCode;
  return result;
}

/** Normalize human phone inputs only. Group identifiers are never phone numbers. */
export function whatsappRecipients(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 8 ||
    raw.some((number) => typeof number !== "string")
  )
    throw new Error("Use one to eight unique E.164 recipients.");
  const numbers = raw.map((number: string) => number.replace(/[\s().-]/g, ""));
  if (
    numbers.some((number) => !/^\+[1-9]\d{6,14}$/.test(number)) ||
    new Set(numbers).size !== numbers.length
  )
    throw new Error("Use one to eight unique E.164 recipients.");
  return numbers;
}

/** Reserve control consumption before side effects; retain the first session route. */
export function reserveWhatsAppIngress(
  message: InboundMessage,
  control: boolean,
  store: StateStore,
): { first: boolean; chatKey: string; control: boolean } {
  const source = message.whatsappSource;
  if (!source || !message.conversationId || !source.identityId || !source.messageId)
    throw new Error("WhatsApp ingress ownership is unavailable.");
  const key = `ingress:${createHash("sha256")
    .update(JSON.stringify([source.identityId, source.messageId]))
    .digest("hex")}`;
  const textHash = createHash("sha256")
    .update(message.rawText ?? message.text)
    .digest("hex");
  const candidate = {
    ingress: true,
    identityId: source.identityId,
    sourceId: source.messageId,
    conversationId: message.conversationId,
    author: message.from,
    textHash,
    chatKey: message.chatKey,
    control,
  };
  let first = false,
    result = candidate;
  store.updateWhatsAppSend(key, (existing) => {
    if (!existing) {
      first = true;
      return candidate;
    }
    const old = existing as typeof candidate;
    if (
      old.ingress !== true ||
      old.identityId !== candidate.identityId ||
      old.sourceId !== candidate.sourceId ||
      old.conversationId !== candidate.conversationId ||
      old.author !== candidate.author ||
      old.textHash !== textHash
    )
      throw new Error("Conflicting WhatsApp source ownership.");
    result = old;
    return old;
  });
  return { first, chatKey: result.chatKey, control: result.control };
}
