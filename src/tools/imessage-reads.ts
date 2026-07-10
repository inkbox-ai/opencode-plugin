import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listIMessageConversationsArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum number of conversations to return.")
    .optional(),
  offset: z.number().int().min(0).describe("Pagination offset.").optional(),
};

const getIMessageConversationArgs = {
  conversationId: z
    .string()
    .describe("Inkbox iMessage conversation UUID from `inkbox_list_imessage_conversations`."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum number of messages to return.")
    .optional(),
  offset: z.number().int().min(0).optional(),
};

const listIMessageAssignmentsArgs = {
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

const sendIMessageReactionArgs = {
  messageId: z.string().describe("UUID of the iMessage being reacted to."),
  reaction: z
    .enum(["love", "like", "dislike", "laugh", "emphasize", "question"])
    .describe("Tapback kind."),
  partIndex: z
    .number()
    .int()
    .min(0)
    .describe("Part of a multi-part message to react to.")
    .optional(),
};

const markIMessageConversationReadArgs = {
  conversationId: z.string().describe("Inkbox iMessage conversation UUID."),
};

type ListIMessageConversationsArgs = z.infer<z.ZodObject<typeof listIMessageConversationsArgs>>;
type GetIMessageConversationArgs = z.infer<z.ZodObject<typeof getIMessageConversationArgs>>;
type ListIMessageAssignmentsArgs = z.infer<z.ZodObject<typeof listIMessageAssignmentsArgs>>;
type SendIMessageReactionArgs = z.infer<z.ZodObject<typeof sendIMessageReactionArgs>>;
type MarkIMessageConversationReadArgs = z.infer<
  z.ZodObject<typeof markIMessageConversationReadArgs>
>;

// Read/lifecycle surface for iMessage. Conversations are the canonical
// thread key — iMessage rides shared Inkbox-managed numbers, so there is no
// local-number addressing and no group support.
export function imessageReadTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_imessage_conversations",
      group: "imessage",
      defaultEnabled: true,
      definition: {
        description:
          "List iMessage conversation summaries for the configured Inkbox identity. Returns conversation IDs for replies, latest-message previews, unread counts, and `assignmentStatus` (released = that person disconnected from the agent; replies fail until they reconnect through the Inkbox iMessage router).",
        args: listIMessageConversationsArgs,
        async execute(args: ListIMessageConversationsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const convos = await identity.listIMessageConversations({
              limit: args.limit ?? 25,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${convos.length} iMessage conversation(s).`, convos);
          });
        },
      },
    },
    {
      name: "inkbox_get_imessage_conversation",
      group: "imessage",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch messages in one iMessage conversation, newest first. Messages include any live tapback reactions.",
        args: getIMessageConversationArgs,
        async execute(args: GetIMessageConversationArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const msgs = await identity.listIMessages({
              conversationId: args.conversationId,
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(
              `Returned ${msgs.length} iMessage(s) in conversation ${args.conversationId}.`,
              msgs,
            );
          });
        },
      },
    },
    {
      name: "inkbox_imessage_triage_number",
      group: "imessage",
      defaultEnabled: false,
      definition: {
        description:
          "Return the Inkbox iMessage router number and the connect command a person texts to it (from an iPhone) to reach this agent over iMessage. Share these when someone asks how to iMessage the agent.",
        args: {},
        async execute() {
          return runTool(async () => {
            const [client, identity] = await Promise.all([
              runtime.getClient(),
              runtime.getIdentity(),
            ]);
            const triage = await client.imessages.getTriageNumber();
            // The server may return a placeholder command; pin it to this
            // identity's handle so the agent can hand it out verbatim.
            const connectCommand =
              triage.connectCommand && !triage.connectCommand.includes("your-handle")
                ? triage.connectCommand
                : `connect @${identity.agentHandle}`;
            return formatJson({ number: triage.number, connectCommand });
          });
        },
      },
    },
    {
      name: "inkbox_list_imessage_assignments",
      group: "imessage",
      defaultEnabled: false,
      definition: {
        description:
          "List the people actively connected to this agent over iMessage (one row per recipient, newest first). Released connections are not returned. Use to answer who the agent can currently iMessage.",
        args: listIMessageAssignmentsArgs,
        async execute(args: ListIMessageAssignmentsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const assignments = await identity.listIMessageAssignments({
              limit: args.limit ?? 25,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(
              `Returned ${assignments.length} active iMessage connection(s).`,
              assignments,
            );
          });
        },
      },
    },
    {
      name: "inkbox_send_imessage_reaction",
      group: "imessage",
      defaultEnabled: false,
      definition: {
        description: "Send a tapback reaction to an iMessage the agent received.",
        args: sendIMessageReactionArgs,
        async execute(args: SendIMessageReactionArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const reaction = await identity.sendIMessageReaction({
              messageId: args.messageId,
              reaction: args.reaction,
              partIndex: args.partIndex ?? 0,
            });
            return {
              title: `Sent ${reaction.reaction} tapback`,
              output: `Sent ${reaction.reaction} tapback to message ${args.messageId} (reaction id=${reaction.id}).`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_mark_imessage_conversation_read",
      group: "imessage",
      defaultEnabled: false,
      definition: {
        description:
          "Send a read receipt and mark every inbound message in an iMessage conversation as read.",
        args: markIMessageConversationReadArgs,
        async execute(args: MarkIMessageConversationReadArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const result = await identity.markIMessageConversationRead(args.conversationId);
            return {
              title: `Marked ${result.updatedCount} message(s) as read`,
              output: `Marked ${result.updatedCount} message(s) as read in conversation ${args.conversationId}.`,
            };
          });
        },
      },
    },
  ];
}
