import { z } from "zod";
import { runTool } from "../errors.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const forwardEmailArgs = {
  messageId: z.string().describe("UUID of the message to forward."),
  to: z.array(z.string()).describe("Primary recipients of the forward.").optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  mode: z
    .enum(["inline", "wrapped"])
    .describe(
      "Inline (default) re-attaches original parts. Wrapped attaches the original as a single .eml-style note.",
    )
    .optional(),
  subject: z
    .string()
    .describe("Override subject. Defaults to 'Fwd: <original subject>'.")
    .optional(),
  bodyText: z
    .string()
    .describe(
      "Optional caller note prepended above the original body (inline) or as a top-level note (wrapped).",
    )
    .optional(),
  bodyHtml: z.string().describe("Optional HTML caller note.").optional(),
  includeOriginalAttachments: z
    .boolean()
    .describe(
      "Inline mode only. When true (default), original attachments are re-attached. Ignored in wrapped mode.",
    )
    .optional(),
  replyTo: z.string().describe("Optional Reply-To address.").optional(),
};

type ForwardEmailArgs = z.infer<z.ZodObject<typeof forwardEmailArgs>>;

// Forward a previously received message out from the identity's mailbox.
// Inline (default) re-attaches original parts; wrapped attaches the original
// as a single .eml-style note. Disabled by default — not every workflow
// needs it.
export function forwardEmailTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, config } = deps;
  return [
    {
      name: "inkbox_forward_email",
      group: "email",
      defaultEnabled: false,
      definition: {
        description:
          "Forward a previously received email from the configured Inkbox identity's mailbox to one or more new recipients. Use 'inline' mode to re-attach original parts, or 'wrapped' to attach the original as a single .eml-style note.",
        args: forwardEmailArgs,
        async execute(args: ForwardEmailArgs, ctx) {
          return runTool(async () => {
            // Approval covers every address the forward reaches (to/cc/bcc).
            const all = [...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])];
            if (all.length === 0) {
              throw new Error(
                "inkbox_forward_email requires at least one recipient across to/cc/bcc.",
              );
            }
            await approveOutbound(ctx, config, {
              tool: "inkbox_forward_email",
              recipients: all,
              summary: `Forward message ${args.messageId} to ${all.join(", ")}`,
              metadata: { messageId: args.messageId, mode: args.mode ?? "inline" },
            });

            const identity = await runtime.getIdentity();
            const msg = await identity.forwardEmail(args.messageId, {
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              mode: args.mode,
              subject: args.subject,
              bodyText: args.bodyText,
              bodyHtml: args.bodyHtml,
              includeOriginalAttachments: args.includeOriginalAttachments,
              replyTo: args.replyTo,
            });
            // Build a recipient summary; at least one of to/cc/bcc is required
            // by the API, so this is always non-empty.
            const recipients = all.join(",");
            return {
              title: "Forwarded email",
              output: `Forwarded message id=${args.messageId} as=${msg.id} to=${recipients} mode=${args.mode ?? "inline"}`,
            };
          });
        },
      },
    },
  ];
}
