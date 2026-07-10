import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig, ResolvedGatewayConfig } from "../config.js";
import type { ContactResolver } from "./contacts.js";
import type { NotifyOnce } from "./dedup.js";
import { downloadMedia, mediaDir } from "./media.js";
import type {
  Channel,
  GatewayLogger,
  InboundMessage,
  SessionManager,
  VerifiedEvent,
} from "./types.js";

// Carrier control words are acknowledged by Inkbox, not the agent — drop them.
const CONTROL_WORDS = new Set([
  "stop",
  "start",
  "help",
  "unstop",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

export interface DispatchDeps {
  config: ResolvedConfig;
  inkbox: InkboxRuntime;
  contacts: ContactResolver;
  sessions: SessionManager;
  notify: NotifyOnce;
  logger: GatewayLogger;
  // Handle a verified non-Inkbox (external) webhook.
  onExternal?(event: VerifiedEvent): Promise<void>;
}

// Route a verified event to the right handler. Returns false only on a
// genuine processing failure (so the request id rolls back and the sender
// may retry); filtered/ignored events return true (ack, no retry).
export async function dispatchEvent(deps: DispatchDeps, event: VerifiedEvent): Promise<boolean> {
  if (event.provider !== "inkbox") {
    if (deps.onExternal) await deps.onExternal(event);
    return true;
  }
  const type = event.eventType ?? inferType(event.body);
  switch (type) {
    case "message.received":
      return handleInbound(deps, "email", event);
    case "text.received":
      return handleInbound(deps, "sms", event);
    case "imessage.received":
      return handleInbound(deps, "imessage", event);
    case "imessage.reaction_received":
      return handleReaction(deps, event);
    case "text.delivery_failed":
    case "text.delivery_unconfirmed":
    case "imessage.delivery_failed":
    case "message.bounced":
    case "message.failed":
      return handleDeliveryFailure(deps, type, event);
    default:
      deps.logger.info("dispatch.ignored", { type });
      return true;
  }
}

function inferType(body: Record<string, unknown>): string | undefined {
  return typeof body.event_type === "string" ? body.event_type : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function firstString(v: unknown): string | undefined {
  return Array.isArray(v) ? str(v[0]) : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// Inbound webhooks wrap the resource under `data`, keyed by channel: mail and
// iMessage messages under `message`, texts under `text_message`, reactions
// under `reaction`. Return the sub-resource for the given key.
function resourceOf(
  body: Record<string, unknown>,
  key: "message" | "text_message" | "reaction",
): Record<string, unknown> | undefined {
  const data = record(body.data) ?? body;
  return record(data[key]);
}

// Media items carry a `url`; collect them regardless of channel.
function mediaUrlsOf(resource: Record<string, unknown>): string[] {
  const media = resource.media;
  if (!Array.isArray(media)) return [];
  return media
    .map((item) => (record(item) ? str((item as Record<string, unknown>).url) : undefined))
    .filter((u): u is string => Boolean(u));
}

async function selfAddresses(inkbox: InkboxRuntime): Promise<Set<string>> {
  try {
    const id = await inkbox.getIdentity();
    const out = new Set<string>();
    if (id.emailAddress) out.add(id.emailAddress.toLowerCase());
    if (id.phoneNumber?.number) out.add(id.phoneNumber.number.toLowerCase());
    return out;
  } catch {
    return new Set();
  }
}

function senderAllowed(
  from: string,
  contactId: string | undefined,
  g: ResolvedGatewayConfig,
): boolean {
  if (g.allowedInboundContactIds.length > 0) {
    if (!contactId || !g.allowedInboundContactIds.includes(contactId)) return false;
  }
  if (g.allowAllUsers || g.allowedUsers.length === 0) return true;
  const norm = from.trim().toLowerCase();
  return g.allowedUsers.some((u) => u.trim().toLowerCase() === norm);
}

// Per-channel field extraction from the sub-resource. Mail is keyed by email
// address and RFC Message-ID; texts by remote number + conversation; iMessage
// by remote number + conversation, with `content` as the body.
function extractInbound(
  channel: Exclude<Channel, "voice">,
  body: Record<string, unknown>,
): {
  resource?: Record<string, unknown>;
  from?: string;
  text: string;
  subject?: string;
  conversationId?: string;
  threadId?: string;
  messageId?: string;
  rfcMessageId?: string;
} {
  if (channel === "email") {
    const r = resourceOf(body, "message");
    return {
      resource: r,
      from: str(r?.from_address),
      text: str(r?.body) ?? "",
      subject: str(r?.subject),
      threadId: str(r?.thread_id),
      messageId: str(r?.id),
      rfcMessageId: str(r?.message_id),
    };
  }
  if (channel === "sms") {
    const r = resourceOf(body, "text_message");
    return {
      resource: r,
      from: str(r?.remote_phone_number),
      text: str(r?.text) ?? "",
      conversationId: str(r?.conversation_id),
      messageId: str(r?.id),
    };
  }
  const r = resourceOf(body, "message");
  return {
    resource: r,
    from: str(r?.remote_number),
    text: str(r?.content) ?? "",
    conversationId: str(r?.conversation_id),
    messageId: str(r?.id),
  };
}

async function handleInbound(
  deps: DispatchDeps,
  channel: Exclude<Channel, "voice">,
  event: VerifiedEvent,
): Promise<boolean> {
  const info = extractInbound(channel, event.body);
  const from = info.from;
  if (!from) {
    deps.logger.warn("dispatch.no_sender", { channel });
    return true;
  }

  const selves = await selfAddresses(deps.inkbox);
  if (selves.has(from.toLowerCase())) return true;

  if (channel === "sms" && CONTROL_WORDS.has(info.text.trim().toLowerCase())) return true;

  const { contactId, contactName } = await deps.contacts.resolve(from);
  if (!senderAllowed(from, contactId, deps.config.gateway)) {
    deps.logger.info("dispatch.blocked_sender", { channel });
    return true;
  }

  const chatKey = deps.contacts.chatKeyFor({
    contactId,
    channel,
    threadId: info.threadId,
    conversationId: info.conversationId,
    from,
  });

  const mediaUrls = info.resource ? mediaUrlsOf(info.resource) : [];
  const mediaPaths =
    mediaUrls.length > 0
      ? await downloadMedia(mediaUrls, { dir: mediaDir(deps.config), logger: deps.logger })
      : [];

  const participants = countParticipants(event.body);

  const msg: InboundMessage = {
    channel,
    chatKey,
    from,
    conversationId: info.conversationId,
    threadId: info.threadId,
    subject: info.subject,
    messageId: info.messageId,
    rfcMessageId: info.rfcMessageId,
    contactId,
    contactName,
    text: info.text,
    mediaPaths,
    ...(participants > 1 ? { group: { participantCount: participants } } : {}),
  };

  // A media-only message still wakes the agent.
  if (msg.text.trim() === "" && msg.mediaPaths.length === 0) {
    deps.logger.info("dispatch.empty", { channel });
    return true;
  }

  // Kick off the turn without blocking the webhook response — a model run can
  // take minutes, and holding the HTTP request open makes the provider retry.
  void deps.sessions
    .handleInbound(msg)
    .catch((err) => deps.logger.error("turn.dispatch_failed", { error: String(err) }));
  return true;
}

// Group detection: the number of distinct remote parties resolved for the
// event (contacts + identities), when the platform reports more than one.
function countParticipants(body: Record<string, unknown>): number {
  const data = record(body.data);
  const contacts = Array.isArray(data?.contacts) ? data?.contacts.length : 0;
  const identities = Array.isArray(data?.agent_identities) ? data?.agent_identities.length : 0;
  return Math.max(contacts, identities);
}

async function handleReaction(deps: DispatchDeps, event: VerifiedEvent): Promise<boolean> {
  const r = resourceOf(event.body, "reaction");
  const from = str(r?.remote_number);
  const conversationId = str(r?.conversation_id);
  const reaction = str(r?.reaction) ?? "reaction";
  if (!from) return true;
  const { contactId, contactName } = await deps.contacts.resolve(from);
  if (!senderAllowed(from, contactId, deps.config.gateway)) return true;
  const chatKey = deps.contacts.chatKeyFor({
    contactId,
    channel: "imessage",
    conversationId,
    from,
  });
  void deps.sessions
    .handleInbound({
      channel: "imessage",
      chatKey,
      from,
      conversationId,
      contactId,
      contactName,
      text: `[reaction: ${reaction}]`,
      mediaPaths: [],
      messageId: str(r?.id),
    })
    .catch((err) => deps.logger.error("turn.dispatch_failed", { error: String(err) }));
  return true;
}

// Delivery failures wake the session as a capture turn (reply not delivered),
// deduped once per message id so a retry storm doesn't repeat the nudge.
async function handleDeliveryFailure(
  deps: DispatchDeps,
  type: string,
  event: VerifiedEvent,
): Promise<boolean> {
  // Failure payloads carry the same sub-resource as their channel's messages.
  const isText = type.startsWith("text");
  const isImessage = type.startsWith("imessage");
  const r = resourceOf(event.body, isText ? "text_message" : "message");
  const messageId = str(r?.id);
  const to = isText
    ? str(r?.remote_phone_number)
    : isImessage
      ? str(r?.remote_number)
      : firstString(r?.to_addresses);
  const from = to;
  // Check recoverability before consuming the once-per-TTL notify slot.
  if (!from) return true;
  if (messageId && !deps.notify.shouldNotify(`${type}:${messageId}`)) return true;
  const { contactId } = await deps.contacts.resolve(from);
  const chatKey = deps.contacts.chatKeyFor({
    contactId,
    channel: (type.startsWith("imessage")
      ? "imessage"
      : type.startsWith("text")
        ? "sms"
        : "email") as Exclude<Channel, "voice">,
    from,
  });
  const reason = str(r?.error_detail) ?? str(r?.error_code) ?? str(r?.error_reason) ?? type;
  void deps.sessions
    .runCapture(
      chatKey,
      `A message to ${from} failed to deliver (${type}: ${reason}). Consider retrying or switching channel.`,
    )
    .catch((err) => deps.logger.error("turn.dispatch_failed", { error: String(err) }));
  return true;
}
