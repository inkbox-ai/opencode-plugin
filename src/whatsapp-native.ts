import { createHash } from "node:crypto";
import type { AgentIdentity } from "@inkbox/sdk";
import { createStateStore, type StateStore } from "./gateway/state.js";
import type { CommandTargets, InboundMessage, ReplyTarget } from "./gateway/types.js";
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
  if (
    target?.channel === "whatsapp" &&
    (target.group || hasWhatsAppGroupShape(target) || Array.isArray(target.to))
  )
    throw new Error("WhatsApp supports direct messages only.");
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

// A caller-supplied quote or key that cannot be sent is not an unknown delivery.
function assertSendableWhatsAppRequest(
  input: {
    to?: string;
    conversationId?: string;
    replyToMessageId?: string;
    text?: string;
    mediaIds?: string[];
    idempotencyKey: string;
  },
  explicitQuote: boolean,
): void {
  if ((input.to == null) === (input.conversationId == null))
    throw new Error("Specify exactly one of to or conversationId");
  if (input.to != null) whatsappRecipient(input.to);
  if (
    explicitQuote &&
    input.replyToMessageId != null &&
    (!input.conversationId ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.replyToMessageId))
  )
    throw new Error("replyToMessageId requires conversationId and a valid message UUID");
  if ((input.mediaIds?.length ?? 0) > 1)
    throw new Error("WhatsApp supports at most one attachment");
  if (!input.text?.trim() && !input.mediaIds?.length)
    throw new Error("Provide text or one media ID");
  if (input.text != null && Array.from(input.text).length > 4000)
    throw new Error("WhatsApp text must be at most 4000 characters");
  const key = input.idempotencyKey;
  const length = Array.from(key).length;
  if (length < 1 || length > 255)
    throw new RangeError("idempotencyKey must contain between 1 and 255 characters");
  if (!key.trim() || /[^\x20-\x7e]/.test(key))
    throw new RangeError("Use a printable ASCII idempotency key");
}

export async function prepareWhatsApp(
  identity: AgentIdentity,
  target: WhatsAppOwner,
  payload: { text?: string; mediaIds?: string[]; replyToMessageId?: string },
  store = createStateStore(),
  originalKey?: string,
  inheritSourceQuote = true,
  requestId?: string,
) {
  if (typeof identity.sendWhatsApp !== "function")
    throw new Error("WhatsApp requires Inkbox SDK 0.7.26 or newer.");
  assertWhatsAppText(payload.text ?? "");
  const suppliedQuote = payload.replyToMessageId;
  const source = target.whatsappSource;
  if (
    target.group ||
    "whatsappRecipients" in target ||
    hasWhatsAppGroupShape(target) ||
    hasWhatsAppGroupShape(payload)
  )
    throw new Error("WhatsApp supports direct messages only.");
  const destination = target.to;
  if (destination !== undefined) whatsappRecipient(destination);
  if (!(target.conversationId || destination) || (source && source.identityId !== identity.id))
    throw new Error("The original WhatsApp identity or conversation changed.");
  assertWhatsAppOwner(target, store);
  if (target.conversationId) {
    const conversation = await identity.getWhatsAppConversation(target.conversationId);
    if (
      conversation.agentIdentityId !== identity.id ||
      hasWhatsAppGroupShape(conversation) ||
      conversation.participants.length !== 1
    )
      throw new Error("An owned direct WhatsApp conversation is required.");
    whatsappRecipient(conversation.participants[0]);
  }
  const keyFor = (body: typeof payload) =>
    `opencode:whatsapp:${createHash("sha256")
      .update(
        JSON.stringify([
          identity.id,
          target.conversationId ?? destination,
          source?.messageId ?? target.messageId,
          body,
          ...(requestId ? [requestId] : []),
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
  if (
    saved &&
    (Array.isArray(saved.to) || hasWhatsAppGroupShape(saved) || hasWhatsAppGroupShape(savedPayload))
  )
    throw new Error("Stored WhatsApp group intents cannot be sent as direct messages.");
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
    const priorAttempt = Object.values(store.read().whatsappSends ?? {}).find(
      (send: any) =>
        source &&
        send.sourceId === source.messageId &&
        send.identityId === identity.id &&
        send.conversationId?.toLowerCase() === target.conversationId?.toLowerCase() &&
        (send.quoteAttempt || send.explicit) &&
        ["started", "rejected"].includes(send.state) &&
        send.idempotencyKey !== idempotencyKey,
    );
    if (priorAttempt)
      throw new Error(
        "The source has an unresolved explicit send; retain its original key and payload.",
      );
    const existingSends = (store.read().whatsappSends ?? {}) as Record<string, unknown>;
    if (!(idempotencyKey in existingSends)) {
      assertSendableWhatsAppRequest(
        {
          ...(target.conversationId
            ? { conversationId: target.conversationId }
            : { to: destination }),
          text: payload.text,
          mediaIds: payload.mediaIds,
          replyToMessageId: payload.replyToMessageId,
          idempotencyKey,
        },
        Boolean(originalKey && suppliedQuote),
      );
    }
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
          `A WhatsApp attempt returned a rejection; an earlier attempt may remain uncertain: ${JSON.stringify(policy)}. Inspect inkbox_lookup_whatsapp_send with the original key. Follow retry_condition; retain the original key and unchanged payload and owned media ID; do not create a new copy.`,
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
      send.conversationId?.toLowerCase() === target.conversationId?.toLowerCase() &&
      (["started", "sent", "rejected"].includes(send.state) || send.quoteAttempt === true),
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

/** Reject unsupported event and persisted request shapes before routing or sending. */
export function hasWhatsAppGroupShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (key === "group" && Boolean(item)) ||
      key === "whatsappRecipients" ||
      ((key === "is_group" || key === "isGroup") && item !== false && item != null) ||
      ((key.startsWith("group_") ||
        key.startsWith("groupName") ||
        key.startsWith("groupCreation")) &&
        item != null) ||
      ((key === "unresolvedParticipantCount" || key === "unresolved_participant_count") &&
        item != null &&
        item !== 0) ||
      (key === "participants" && (!Array.isArray(item) || item.length !== 1)) ||
      (key === "recipients" && (!Array.isArray(item) || item.length > 1)),
  );
}

export function whatsappRecipient(value: unknown): string {
  if (typeof value !== "string" || !/^\+[1-9]\d{6,14}$/.test(value))
    throw new Error(
      "Use one E.164 recipient string; recipient arrays and lists are not supported.",
    );
  return value;
}

export type WhatsAppIngressDisposition =
  | { kind: "permission"; waiterId: string }
  | { kind: "normal"; waiterId: string | null }
  | { kind: "command"; waiterId: string | null; targets: CommandTargets };

/** Retain the first route, but distinguish reservation from completed control handling. */
export function reserveWhatsAppIngress(
  message: InboundMessage,
  control: boolean,
  store: StateStore,
  disposition: () => WhatsAppIngressDisposition,
): {
  first: boolean;
  chatKey: string;
  control: boolean;
  completed: boolean;
  disposition?: WhatsAppIngressDisposition;
  complete(): void;
} {
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
    disposition: undefined as WhatsAppIngressDisposition | undefined,
    ingress: true,
    completed: false,
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
      candidate.disposition = disposition();
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
  return {
    first,
    chatKey: result.chatKey,
    control: result.control,
    // Legacy controls have no immutable targets; never retarget their uncertain effects.
    completed: (result.completed ?? result.control) || (result.control && !result.disposition),
    disposition: result.disposition,
    complete() {
      store.updateWhatsAppSend(key, (entry) => ({
        ...(entry as typeof candidate),
        completed: true,
      }));
    },
  };
}
