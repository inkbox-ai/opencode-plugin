import { z } from "zod";
import { runTool } from "../errors.js";
import { uploadLocalMedia } from "../gateway/media.js";
import { assertIMessageTextWithinLimit, IMESSAGE_MAX_TEXT_CHARS } from "../limits.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const SEND_STYLES = [
  "celebration",
  "shooting_star",
  "fireworks",
  "lasers",
  "love",
  "confetti",
  "balloons",
  "spotlight",
  "echo",
  "invisible",
  "gentle",
  "loud",
  "slam",
] as const;

const sendIMessageArgs = {
  to: z
    .string()
    .describe(
      "Recipient phone number in E.164 format. Only works after that person has messaged this agent. Mutually exclusive with `conversationId`.",
    )
    .optional(),
  conversationId: z
    .string()
    .describe(
      "Existing Inkbox iMessage conversation UUID. Preferred for replies. Mutually exclusive with `to`.",
    )
    .optional(),
  text: z
    .string()
    .max(IMESSAGE_MAX_TEXT_CHARS)
    .describe("Message body, max 18995 chars. Provide `text`, `mediaUrls`, or both.")
    .optional(),
  mediaUrls: z
    .array(z.string().describe("Publicly fetchable media URL."))
    .min(1)
    .max(1)
    .describe("Optional media attachment (at most one per message).")
    .optional(),
  mediaPaths: z.array(z.string()).describe("Local file paths to attach.").optional(),
  sendStyle: z.enum(SEND_STYLES).describe("Optional expressive iMessage send style.").optional(),
};

type SendIMessageArgs = z.infer<z.ZodObject<typeof sendIMessageArgs>>;

// Outbound iMessage — recipient-first channel: a person must have messaged
// this identity through the Inkbox iMessage router before outbound sends
// work, so there is no cold outreach. Server-side gates (no prior message,
// released connection, quota) surface as API errors, not local pre-checks.
export function sendIMessageTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, config } = deps;
  return [
    {
      name: "inkbox_send_imessage",
      group: "imessage",
      defaultEnabled: true,
      definition: {
        description:
          "Send an iMessage from the configured Inkbox identity. Recipient-first channel: a person must have connected via the Inkbox iMessage router and messaged this agent before outbound sends work, so prefer `conversationId` from an inbound message or `inkbox_list_imessage_conversations`.",
        args: sendIMessageArgs,
        async execute(args: SendIMessageArgs, ctx) {
          return runTool(async () => {
            const text = typeof args.text === "string" ? args.text : "";
            const mediaUrls = Array.isArray(args.mediaUrls) ? args.mediaUrls : undefined;
            const mediaPaths = Array.isArray(args.mediaPaths) ? args.mediaPaths : undefined;
            if (!text && !mediaUrls?.length && !mediaPaths?.length) {
              throw new Error("Provide `text`, `mediaUrls`, or both.");
            }
            assertIMessageTextWithinLimit(text);
            const conversationId =
              typeof args.conversationId === "string" ? args.conversationId.trim() : "";
            const to = typeof args.to === "string" ? args.to.trim() : "";
            if (Boolean(conversationId) === Boolean(to)) {
              throw new Error("Specify exactly one of `to` or `conversationId`.");
            }
            // A conversation send resolves the recipient server-side, so a
            // local allowlist cannot vet it — refuse rather than silently bypass.
            if (conversationId && config.outbound.allowedRecipients.length > 0) {
              throw new Error(
                "`conversationId` sends cannot be checked against the local outbound recipient allowlist. Use an explicit `to` recipient or adjust the allowlist.",
              );
            }
            const detail = text ? `${text.length} chars` : "media attachment";
            await approveOutbound(ctx, config, {
              tool: "inkbox_send_imessage",
              recipients: conversationId ? [] : [to],
              ...(conversationId ? { patterns: [`conversation:${conversationId}`] } : {}),
              summary: conversationId
                ? `Send iMessage to conversation ${conversationId} (${detail})`
                : `Send iMessage to ${to} (${detail})`,
              metadata: {
                textChars: text.length,
                mediaCount: (mediaUrls?.length ?? 0) + (mediaPaths?.length ?? 0),
              },
            });

            const identity = await runtime.getIdentity();
            // Uploaded local files lead, then any caller-supplied URLs.
            const uploaded = mediaPaths?.length ? await uploadLocalMedia(identity, mediaPaths) : [];
            const allMediaUrls = [...uploaded, ...(mediaUrls ?? [])];
            const msg = await identity.sendIMessage({
              ...(conversationId ? { conversationId } : { to }),
              ...(text ? { text } : {}),
              ...(allMediaUrls.length ? { mediaUrls: allMediaUrls } : {}),
              ...(args.sendStyle ? { sendStyle: args.sendStyle } : {}),
            });
            const target = conversationId ? `conversation=${conversationId}` : `to=${to}`;
            return {
              title: conversationId
                ? `iMessage sent to conversation ${conversationId}`
                : `iMessage sent to ${to}`,
              output: `Sent iMessage id=${msg.id} ${target} conversation_id=${msg.conversationId} status=${msg.status ?? "unknown"}`,
            };
          });
        },
      },
    },
  ];
}
