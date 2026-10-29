import type { InkboxRuntime } from "../client.js";
import { prepareNativeIMessage } from "../imessage-native.js";
import { assertIMessageTextWithinLimit, assertSmsTextWithinLimit } from "../limits.js";
import { checkOutboundRecipients } from "../permissions.js";
import { prepareSlackReply } from "../slack.js";
import { assertWhatsAppText, prepareWhatsApp } from "../whatsapp-native.js";
import { SILENT, stripMarkdown } from "./prompts.js";
import type { StateStore } from "./state.js";
import type { GatewayLogger, ReplyTarget } from "./types.js";

export class ReplyPreparationError extends Error {}

export function sentEmailReply(target: ReplyTarget | undefined, parts: any[]): boolean {
  if (target?.channel !== "email") return false;
  const parents = [target.messageId, target.rfcMessageId].filter(Boolean);
  return parts.some((part) => {
    const state = part.state;
    return (
      part.type === "tool" &&
      part.tool === "inkbox_send_email" &&
      state?.status === "completed" &&
      typeof state.output === "string" &&
      state.output.startsWith("Sent email id=") &&
      parents.includes(state.input?.inReplyToMessageId) &&
      Array.isArray(state.input?.to) &&
      state.input.to.some((to: string) =>
        [target.to, target.sender].some((address) => address?.toLowerCase() === to.toLowerCase()),
      )
    );
  });
}

export interface ReplyResult {
  delivered: boolean;
  reason?: "silent" | "empty" | "sent";
  messageId?: string;
}

// Prepare before marking delivery started: identity/validation failures have
// no send side effect and can retry with the completed model output intact.
export async function prepareReply(
  runtime: InkboxRuntime,
  target: ReplyTarget,
  raw: string,
  logger: GatewayLogger,
  store?: StateStore,
  allowedRecipients?: string[],
  requestId?: string,
): Promise<() => Promise<ReplyResult>> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === SILENT)
    return async () => ({ delivered: false, reason: trimmed ? "silent" : "empty" });
  if (target.channel === "slack") {
    if (!target.slack) throw new ReplyPreparationError("Slack reply route is missing.");
    const client = await runtime.getClient();
    const send = await prepareSlackReply(client, target.slack, trimmed);
    return async () => ({
      delivered: true,
      reason: "sent",
      messageId: await send(),
    });
  }
  const parentId = target.companion?.replyToMessageId ?? target.messageId ?? "";
  if (target.channel === "email" && !parentId)
    throw new ReplyPreparationError("Email reply requires the stored inbound message ID.");
  const body = target.channel === "email" ? trimmed : stripMarkdown(trimmed);
  try {
    if (target.channel === "sms") assertSmsTextWithinLimit(body);
    if (target.channel === "whatsapp") assertWhatsAppText(body);
    if (target.channel === "imessage") assertIMessageTextWithinLimit(body);
  } catch (error) {
    throw new ReplyPreparationError(error instanceof Error ? error.message : String(error));
  }
  const identity = await runtime.getIdentity();
  if (target.channel === "whatsapp") {
    if (target.group) {
      if (!target.conversationId)
        throw new ReplyPreparationError("WhatsApp group replies require their conversation.");
      const conversation = await identity.getWhatsAppConversation(target.conversationId);
      if (
        conversation.agentIdentityId !== identity.id ||
        !conversation.isGroup ||
        !conversation.participants.length ||
        (conversation.unresolvedParticipantCount ?? 0) > 0 ||
        conversation.participants.some((number: string) => !/^\+[1-9]\d{6,14}$/.test(number))
      )
        throw new ReplyPreparationError("An owned resolved WhatsApp group is required.");
      const blocked = checkOutboundRecipients(conversation.participants, allowedRecipients);
      if (blocked) throw new ReplyPreparationError(blocked);
    }
    const send = await prepareWhatsApp(
      identity,
      target,
      { text: body },
      store,
      undefined,
      true,
      requestId,
    );
    return async () => ({ delivered: true, reason: "sent", messageId: (await send()).id });
  }
  const nativeSend =
    target.channel === "imessage" && target.imessageSource
      ? await prepareNativeIMessage(identity, target, { text: body }, store)
      : undefined;
  return async () => {
    const message =
      target.channel === "email"
        ? await identity.replyAllEmail(parentId, { bodyText: body })
        : target.channel === "sms"
          ? await identity.sendText({
              text: body,
              ...(target.conversationId
                ? { conversationId: target.conversationId }
                : { to: target.to }),
            })
          : nativeSend
            ? await nativeSend()
            : await identity.sendIMessage({
                text: body,
                ...(target.conversationId
                  ? { conversationId: target.conversationId }
                  : { to: target.to }),
              });
    logger.info("reply.sent", { channel: target.channel, id: message.id });
    return { delivered: true, reason: "sent", messageId: message.id };
  };
}

export async function deliverReply(
  runtime: InkboxRuntime,
  target: ReplyTarget,
  raw: string,
  logger: GatewayLogger,
  allowedRecipients?: string[],
): Promise<ReplyResult> {
  return (await prepareReply(runtime, target, raw, logger, undefined, allowedRecipients))();
}
