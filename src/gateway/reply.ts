import type { InkboxRuntime } from "../client.js";
import { assertIMessageTextWithinLimit, assertSmsTextWithinLimit } from "../limits.js";
import { SILENT, stripMarkdown } from "./prompts.js";
import type { GatewayLogger, ReplyTarget } from "./types.js";

export interface ReplyResult {
  delivered: boolean;
  reason?: "silent" | "empty" | "sent";
  messageId?: string;
}

// Deliver an assistant turn on the modality the inbound message arrived on.
// Exact-[SILENT] and empty replies are suppressed. Phone channels get
// markdown stripped; length caps are enforced with a clear error so the
// caller can run a split-or-summarize recovery turn.
export async function deliverReply(
  runtime: InkboxRuntime,
  target: ReplyTarget,
  raw: string,
  logger: GatewayLogger,
): Promise<ReplyResult> {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { delivered: false, reason: "empty" };
  if (trimmed === SILENT) return { delivered: false, reason: "silent" };

  const identity = await runtime.getIdentity();

  if (target.channel === "email") {
    const msg = await identity.sendEmail({
      to: [target.to ?? ""],
      subject: replySubject(target.subject),
      bodyText: trimmed,
      // Thread the reply when we captured the original Message-ID.
      ...(target.rfcMessageId ? { inReplyToMessageId: target.rfcMessageId } : {}),
    });
    logger.info("reply.sent", { channel: "email", id: msg.id });
    return { delivered: true, reason: "sent", messageId: msg.id };
  }

  const body = stripMarkdown(trimmed);

  if (target.channel === "sms") {
    assertSmsTextWithinLimit(body);
    const msg = await identity.sendText({
      text: body,
      ...(target.conversationId ? { conversationId: target.conversationId } : { to: target.to }),
    });
    logger.info("reply.sent", { channel: "sms", id: msg.id });
    return { delivered: true, reason: "sent", messageId: msg.id };
  }

  // iMessage
  assertIMessageTextWithinLimit(body);
  const msg = await identity.sendIMessage({
    text: body,
    ...(target.conversationId ? { conversationId: target.conversationId } : { to: target.to }),
  });
  logger.info("reply.sent", { channel: "imessage", id: msg.id });
  return { delivered: true, reason: "sent", messageId: msg.id };
}

function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
