import { MessageDirection } from "@inkbox/sdk";
import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader, takeAsync } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listUnreadEmailsArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum number of messages to return (default 25, max 200).")
    .optional(),
};

const listEmailsArgs = {
  direction: z
    .enum(["inbound", "outbound"])
    .describe("Filter by direction. Omit for both.")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum number of messages to return.")
    .optional(),
};

const getEmailArgs = {
  messageId: z.string().describe("UUID of the message to fetch."),
};

const getEmailThreadArgs = {
  threadId: z.string().describe("UUID of the thread to fetch."),
};

const markEmailsReadArgs = {
  messageIds: z.array(z.string()).min(1).describe("Message UUIDs to mark as read."),
};

type ListUnreadEmailsArgs = z.infer<z.ZodObject<typeof listUnreadEmailsArgs>>;
type ListEmailsArgs = z.infer<z.ZodObject<typeof listEmailsArgs>>;
type GetEmailArgs = z.infer<z.ZodObject<typeof getEmailArgs>>;
type GetEmailThreadArgs = z.infer<z.ZodObject<typeof getEmailThreadArgs>>;
type MarkEmailsReadArgs = z.infer<z.ZodObject<typeof markEmailsReadArgs>>;

// Read-side surface for the email channel. iterEmails / iterUnreadEmails are
// unbounded async generators on the SDK; we cap them with takeAsync() so the
// agent can't accidentally pull a whole mailbox into one tool call.
export function emailReadTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_unread_emails",
      group: "email",
      defaultEnabled: true,
      definition: {
        description:
          "List unread emails in the configured Inkbox identity's mailbox. Returns at most `limit` messages, newest first. Use this as the entry point for email triage flows.",
        args: listUnreadEmailsArgs,
        async execute(args: ListUnreadEmailsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const limit = args.limit ?? 25;
            const msgs = await takeAsync(identity.iterUnreadEmails(), limit);
            return formatWithHeader(`Found ${msgs.length} unread email(s).`, msgs);
          });
        },
      },
    },
    {
      name: "inkbox_list_emails",
      group: "email",
      defaultEnabled: true,
      definition: {
        description:
          "List emails in the configured Inkbox identity's mailbox. Optionally filter by direction (inbound/outbound). Returns at most `limit` messages, newest first.",
        args: listEmailsArgs,
        async execute(args: ListEmailsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const limit = args.limit ?? 25;
            const direction =
              args.direction === "inbound"
                ? MessageDirection.INBOUND
                : args.direction === "outbound"
                  ? MessageDirection.OUTBOUND
                  : undefined;
            const msgs = await takeAsync(identity.iterEmails({ direction }), limit);
            return formatWithHeader(`Returned ${msgs.length} email(s).`, msgs);
          });
        },
      },
    },
    {
      name: "inkbox_get_email",
      group: "email",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch a single email by message UUID. Returns full body (text + HTML), addresses, and threading info.",
        args: getEmailArgs,
        async execute(args: GetEmailArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const msg = await identity.getMessage(args.messageId);
            return formatJson(msg);
          });
        },
      },
    },
    {
      name: "inkbox_get_email_thread",
      group: "email",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch a full email thread by thread UUID. Messages returned oldest-first. Includes the thread's folder (inbox/spam/archive/blocked).",
        args: getEmailThreadArgs,
        async execute(args: GetEmailThreadArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const thread = await identity.getThread(args.threadId);
            return formatJson(thread);
          });
        },
      },
    },
    {
      name: "inkbox_mark_emails_read",
      group: "email",
      defaultEnabled: false,
      definition: {
        description:
          "Mark one or more emails as read by message UUID. Pair with inkbox_list_unread_emails to clear the unread queue after processing.",
        args: markEmailsReadArgs,
        async execute(args: MarkEmailsReadArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            await identity.markEmailsRead(args.messageIds);
            return {
              title: `Marked ${args.messageIds.length} email(s) as read`,
              output: `Marked ${args.messageIds.length} email(s) as read.`,
            };
          });
        },
      },
    },
  ];
}
