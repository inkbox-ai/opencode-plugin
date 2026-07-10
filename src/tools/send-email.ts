import { z } from "zod";
import { runTool } from "../errors.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const sendEmailArgs = {
  to: z
    .array(z.string().describe("Recipient email address"))
    .min(1)
    .describe("Primary recipients (at least one required)."),
  subject: z.string().describe("Email subject line"),
  bodyText: z.string().describe("Plain-text body").optional(),
  bodyHtml: z.string().describe("HTML body").optional(),
  cc: z.array(z.string()).describe("CC recipients").optional(),
  bcc: z.array(z.string()).describe("BCC recipients").optional(),
  inReplyToMessageId: z
    .string()
    .describe(
      "RFC 5322 Message-ID of the message being replied to. Pass this when threading a reply so the recipient's client groups the conversation.",
    )
    .optional(),
};

type SendEmailArgs = z.infer<z.ZodObject<typeof sendEmailArgs>>;

// Outbound email — the primary write path for the email channel.
export function sendEmailTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, config } = deps;
  return [
    {
      name: "inkbox_send_email",
      group: "email",
      defaultEnabled: true,
      definition: {
        description:
          "Send an email from the configured Inkbox identity. Use for outbound messages addressed to one or more email recipients. Supports CC/BCC and reply threading via inReplyToMessageId.",
        args: sendEmailArgs,
        async execute(args: SendEmailArgs, ctx) {
          return runTool(async () => {
            // Approval covers every address the message reaches: to/cc/bcc.
            const all = [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])];
            await approveOutbound(ctx, config, {
              tool: "inkbox_send_email",
              recipients: all,
              summary: `Send email to ${args.to.join(", ")}: "${args.subject}"`,
              metadata: { subject: args.subject },
            });

            const identity = await runtime.getIdentity();
            const msg = await identity.sendEmail({
              to: args.to,
              subject: args.subject,
              bodyText: args.bodyText,
              bodyHtml: args.bodyHtml,
              cc: args.cc,
              bcc: args.bcc,
              inReplyToMessageId: args.inReplyToMessageId,
            });
            return {
              title: `Email sent to ${args.to.join(", ")}`,
              output: `Sent email id=${msg.id} to=${args.to.join(",")} subject="${args.subject}"`,
            };
          });
        },
      },
    },
  ];
}
