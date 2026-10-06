import type { InkboxRuntime } from "../client.js";
import { prepareNativeIMessage } from "../imessage-native.js";
import { assertIMessageTextWithinLimit, assertSmsTextWithinLimit } from "../limits.js";
import { prepareSlackReply } from "../slack.js";
import { SILENT, stripMarkdown } from "./prompts.js";
import type { StateStore } from "./state.js";
import type { GatewayLogger, ReplyTarget } from "./types.js";

export class ReplyPreparationError extends Error {}

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
    if (target.channel === "imessage") assertIMessageTextWithinLimit(body);
  } catch (error) {
    throw new ReplyPreparationError(error instanceof Error ? error.message : String(error));
  }
  const identity = await runtime.getIdentity();
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
): Promise<ReplyResult> {
  return (await prepareReply(runtime, target, raw, logger))();
}
