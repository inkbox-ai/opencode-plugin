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

const MAX_GROUP_RECIPIENTS = 8;

// `to` accepts one recipient or a list; normalize both to a trimmed array.
function normalizeRecipients(value: unknown): string[] {
  if (typeof value === "string") {
    const entry = value.trim();
    return entry ? [entry] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return [];
}

// Only a dedicated outbound line may open a conversation; everything else is
// recipient-first, so a group send would fail at the API without this check.
function identityCanStartImessageConversations(identity: any): boolean {
  const number = identity?.imessageNumber ?? identity?.imessage_number;
  if (!number) return false;
  const canStart = number.canStartConversations ?? number.can_start_conversations;
  if (typeof canStart === "boolean") return canStart;
  const numberType = number.type?.value ?? number.type;
  return (
    String(numberType ?? "")
      .trim()
      .toLowerCase() === "dedicated_outbound"
  );
}

const sendIMessageArgs = {
  to: z
    .union([z.string(), z.array(z.string()).min(1).max(MAX_GROUP_RECIPIENTS)])
    .describe(
      "One E.164 recipient, or 1-8 distinct recipients. Two or more starts a group and requires a dedicated outbound iMessage line. Mutually exclusive with `conversationId`.",
    )
    .optional(),
  conversationId: z
    .string()
    .describe(
      "Existing Inkbox iMessage conversation UUID. Preferred for 1:1 and group replies. Mutually exclusive with `to`.",
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
            const toList = normalizeRecipients(args.to);
            if (Boolean(conversationId) === Boolean(toList.length)) {
              throw new Error("Specify exactly one of `to` or `conversationId`.");
            }
            if (args.to !== undefined && toList.length === 0) {
              throw new Error("`to` must include at least one recipient.");
            }
            if (new Set(toList).size !== toList.length) {
              throw new Error("iMessage recipients must be distinct.");
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
              recipients: conversationId ? [] : toList,
              ...(conversationId ? { patterns: [`conversation:${conversationId}`] } : {}),
              summary: conversationId
                ? `Send iMessage to conversation ${conversationId} (${detail})`
                : `Send iMessage to ${toList.join(", ")} (${detail})`,
              metadata: {
                textChars: text.length,
                mediaCount: (mediaUrls?.length ?? 0) + (mediaPaths?.length ?? 0),
              },
            });

            const identity = await runtime.getIdentity();
            if (toList.length > 1 && !identityCanStartImessageConversations(identity)) {
              throw new Error(
                "Starting an iMessage group requires a dedicated outbound iMessage line. Reply to an existing group with `conversationId`.",
              );
            }
            // Uploaded local files lead, then any caller-supplied URLs.
            const uploaded = mediaPaths?.length ? await uploadLocalMedia(identity, mediaPaths) : [];
            const allMediaUrls = [...uploaded, ...(mediaUrls ?? [])];
            const msg = await identity.sendIMessage({
              ...(conversationId
                ? { conversationId }
                : { to: toList.length === 1 ? toList[0] : toList }),
              ...(text ? { text } : {}),
              ...(allMediaUrls.length ? { mediaUrls: allMediaUrls } : {}),
              ...(args.sendStyle ? { sendStyle: args.sendStyle } : {}),
            });
            const target = conversationId
              ? `conversation=${conversationId}`
              : `to=${toList.join(",")}`;
            return {
              title: conversationId
                ? `iMessage sent to conversation ${conversationId}`
                : `iMessage sent to ${toList.join(", ")}`,
              output: `Sent iMessage id=${msg.id} ${target} conversation_id=${msg.conversationId} status=${msg.status ?? "unknown"}`,
            };
          });
        },
      },
    },
  ];
}
