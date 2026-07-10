import { z } from "zod";
import { runTool } from "../errors.js";
import { uploadLocalMedia } from "../gateway/media.js";
import { assertSmsTextWithinLimit, SMS_MAX_TEXT_CHARS } from "../limits.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const sendSmsArgs = {
  to: z
    .union([
      z.string().describe("Recipient phone number in E.164 format (e.g. +14155550123)."),
      z
        .array(z.string().describe("Recipient phone number in E.164 format."))
        .min(1)
        .max(8)
        .describe("One to eight recipients. Two or more sends a group MMS."),
    ])
    .optional(),
  conversationId: z
    .string()
    .describe(
      "Existing Inkbox text conversation UUID. Preferred when replying to a listed conversation, especially a group chat. Mutually exclusive with `to`.",
    )
    .optional(),
  text: z.string().min(1).max(SMS_MAX_TEXT_CHARS).describe("Message body (1-1600 chars)."),
  mediaUrls: z
    .array(z.string().describe("Publicly fetchable MMS media URL."))
    .min(1)
    .max(10)
    .describe("Optional MMS media attachments.")
    .optional(),
  mediaPaths: z.array(z.string()).describe("Local file paths to attach as MMS.").optional(),
};

type SendSmsArgs = z.infer<z.ZodObject<typeof sendSmsArgs>>;

// Accept one number or an array; trim entries and drop empties so the
// payload only carries usable values.
function normalizeRecipients(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  return undefined;
}

// Prefer the server-reported recipient list (authoritative for group MMS);
// fall back to the caller's `to` when the response omits it.
function formatTargetSummary(msg: any, args: SendSmsArgs): string {
  if (typeof args.conversationId === "string" && args.conversationId.trim()) {
    return `conversation=${args.conversationId.trim()}`;
  }
  const recipients = Array.isArray(msg?.recipients)
    ? msg.recipients
        .map((entry: any) => entry?.recipientPhoneNumber ?? entry?.recipient_phone_number)
        .filter(Boolean)
    : undefined;
  if (recipients?.length) {
    return `to=${recipients.join(",")}`;
  }
  const toList = normalizeRecipients(args.to) ?? [];
  return `to=${toList.join(",")}`;
}

// Outbound SMS/MMS — sends from the identity's provisioned phone number.
// The Inkbox text API can address a conversation UUID or 1-8 recipients;
// group sends are routed as MMS by Inkbox.
export function sendSmsTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, config } = deps;
  return [
    {
      name: "inkbox_send_sms",
      group: "sms",
      defaultEnabled: true,
      definition: {
        description:
          "Send a text from the configured Inkbox identity's phone number. Use `conversationId` to reply into an existing 1:1 or group conversation, or `to` for one E.164 recipient or a 2-8 recipient group MMS. Recipients must have opted in unless Inkbox policy allows the send.",
        args: sendSmsArgs,
        async execute(args: SendSmsArgs, ctx) {
          return runTool(async () => {
            const conversationId =
              typeof args.conversationId === "string" ? args.conversationId.trim() : "";
            const toList = normalizeRecipients(args.to);
            const hasTo = toList !== undefined && toList.length > 0;
            const hasConversation = Boolean(conversationId);
            if (hasTo === hasConversation) {
              throw new Error("Specify exactly one of `to` or `conversationId`.");
            }
            if (toList?.length === 0) {
              throw new Error("`to` must include at least one recipient.");
            }
            if (toList && toList.length > 8) {
              throw new Error("Inkbox group texts support at most 8 recipients.");
            }
            assertSmsTextWithinLimit(args.text);

            // A conversation send resolves recipients server-side, so a local
            // allowlist cannot vet them — refuse rather than silently bypass.
            if (hasConversation && config.outbound.allowedRecipients.length > 0) {
              throw new Error(
                "`conversationId` sends cannot be checked against the local outbound recipient allowlist. Use explicit `to` recipients or adjust the allowlist.",
              );
            }
            const recipients = hasConversation ? [] : (toList ?? []);
            await approveOutbound(ctx, config, {
              tool: "inkbox_send_sms",
              recipients,
              ...(hasConversation ? { patterns: [`conversation:${conversationId}`] } : {}),
              summary: hasConversation
                ? `Send text to conversation ${conversationId} (${args.text.length} chars)`
                : `Send text to ${recipients.join(", ")} (${args.text.length} chars)`,
              metadata: { textChars: args.text.length },
            });

            const identity = await runtime.getIdentity();
            // Uploaded local files lead, then any caller-supplied URLs.
            const uploaded = args.mediaPaths?.length
              ? await uploadLocalMedia(identity, args.mediaPaths)
              : [];
            const mediaUrls = [...uploaded, ...(args.mediaUrls ?? [])];
            const payload = {
              text: args.text,
              ...(mediaUrls.length ? { mediaUrls } : {}),
              ...(hasConversation
                ? { conversationId }
                : { to: recipients.length === 1 ? recipients[0] : recipients }),
            };
            const msg = await identity.sendText(payload);
            const target = formatTargetSummary(msg, args);
            const status = msg.deliveryStatus ?? "unknown";
            return {
              title: hasConversation
                ? `Text sent to conversation ${conversationId}`
                : `Text sent to ${recipients.join(", ")}`,
              output: `Sent text id=${msg.id} ${target} status=${status} (${args.text.length} chars)`,
            };
          });
        },
      },
    },
  ];
}
