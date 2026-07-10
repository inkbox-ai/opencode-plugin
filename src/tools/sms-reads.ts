import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const conversationIdArg = z
  .string()
  .describe("Inkbox text conversation UUID from `inkbox_list_text_conversations`.")
  .optional();

const remotePhoneNumberArg = z
  .string()
  .describe("Legacy 1:1 remote E.164 phone number identifying the conversation.")
  .optional();

const listTextConversationsArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .describe("Maximum number of conversations to return.")
    .optional(),
  offset: z.number().int().min(0).describe("Pagination offset.").optional(),
  includeGroups: z
    .boolean()
    .describe("Include group conversations. Defaults to true so group SMS triage works.")
    .optional(),
};

const getTextConversationArgs = {
  conversationId: conversationIdArg,
  remotePhoneNumber: remotePhoneNumberArg,
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .describe("Maximum number of messages to return.")
    .optional(),
  offset: z.number().int().min(0).optional(),
};

const listTextsArgs = {
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
  isRead: z.boolean().describe("Filter by read state.").optional(),
};

const getTextArgs = {
  textId: z.string().describe("UUID of the text message."),
};

const markTextReadArgs = {
  textId: z.string().describe("UUID of the text message."),
};

const markTextConversationReadArgs = {
  conversationId: conversationIdArg,
  remotePhoneNumber: remotePhoneNumberArg,
};

type ListTextConversationsArgs = z.infer<z.ZodObject<typeof listTextConversationsArgs>>;
type GetTextConversationArgs = z.infer<z.ZodObject<typeof getTextConversationArgs>>;
type ListTextsArgs = z.infer<z.ZodObject<typeof listTextsArgs>>;
type GetTextArgs = z.infer<z.ZodObject<typeof getTextArgs>>;
type MarkTextReadArgs = z.infer<z.ZodObject<typeof markTextReadArgs>>;
type MarkTextConversationReadArgs = z.infer<z.ZodObject<typeof markTextConversationReadArgs>>;

// Exactly one of conversationId / remotePhoneNumber must identify the thread.
// Returns the SDK conversation key plus a human label for result summaries.
function resolveConversationKey(args: { conversationId?: string; remotePhoneNumber?: string }): {
  key: string;
  label: string;
} {
  const conversationId = args.conversationId?.trim() ?? "";
  const remotePhoneNumber = args.remotePhoneNumber?.trim() ?? "";
  const keyCount = Number(Boolean(conversationId)) + Number(Boolean(remotePhoneNumber));
  if (keyCount !== 1) {
    throw new Error("Specify exactly one of `conversationId` or `remotePhoneNumber`.");
  }
  if (conversationId) {
    return { key: conversationId, label: `conversation ${conversationId}` };
  }
  return { key: remotePhoneNumber, label: `conversation with ${remotePhoneNumber}` };
}

// Read-side surface for SMS/MMS. The server's canonical thread key is
// conversationId, with remotePhoneNumber retained for 1:1 compatibility.
export function smsReadTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_text_conversations",
      group: "sms",
      defaultEnabled: true,
      definition: {
        description:
          "List text conversation summaries for the configured Inkbox identity's phone number. Includes group chats by default; each row carries `id`/`conversationId`-style UUID data, participants, latest message, unread count, and legacy `remotePhoneNumber` for 1:1 threads.",
        args: listTextConversationsArgs,
        async execute(args: ListTextConversationsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const convos = await identity.listTextConversations({
              limit: args.limit ?? 25,
              offset: args.offset ?? 0,
              includeGroups: args.includeGroups ?? true,
            });
            return formatWithHeader(`Returned ${convos.length} text conversation(s).`, convos);
          });
        },
      },
    },
    {
      name: "inkbox_get_text_conversation",
      group: "sms",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch messages in a specific text conversation. Use `conversationId` for group chats or any canonical conversation row; `remotePhoneNumber` is the legacy 1:1 fallback.",
        args: getTextConversationArgs,
        async execute(args: GetTextConversationArgs, _ctx) {
          return runTool(async () => {
            const { key, label } = resolveConversationKey(args);
            const identity = await runtime.getIdentity();
            const msgs = await identity.getTextConversation(key, {
              limit: args.limit ?? 50,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${msgs.length} text(s) in ${label}.`, msgs);
          });
        },
      },
    },
    {
      name: "inkbox_list_texts",
      group: "sms",
      defaultEnabled: false,
      definition: {
        description:
          "List individual SMS messages. Prefer inkbox_list_text_conversations for triage; this one is for low-level access to all texts regardless of conversation.",
        args: listTextsArgs,
        async execute(args: ListTextsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const texts = await identity.listTexts({
              limit: args.limit ?? 25,
              offset: args.offset ?? 0,
              isRead: args.isRead,
            });
            return formatWithHeader(`Returned ${texts.length} text(s).`, texts);
          });
        },
      },
    },
    {
      name: "inkbox_get_text",
      group: "sms",
      defaultEnabled: false,
      definition: {
        description: "Fetch a single SMS by text message UUID. Includes MMS media URLs if present.",
        args: getTextArgs,
        async execute(args: GetTextArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const text = await identity.getText(args.textId);
            return formatJson(text);
          });
        },
      },
    },
    {
      name: "inkbox_mark_text_read",
      group: "sms",
      defaultEnabled: false,
      definition: {
        description: "Mark a single SMS as read.",
        args: markTextReadArgs,
        async execute(args: MarkTextReadArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            await identity.markTextRead(args.textId);
            return {
              title: `Marked text ${args.textId} as read`,
              output: `Marked text ${args.textId} as read.`,
            };
          });
        },
      },
    },
    {
      name: "inkbox_mark_text_conversation_read",
      group: "sms",
      defaultEnabled: false,
      definition: {
        description:
          "Mark every message in a text conversation as read. Use `conversationId` for group chats; `remotePhoneNumber` is the legacy 1:1 fallback.",
        args: markTextConversationReadArgs,
        async execute(args: MarkTextConversationReadArgs, _ctx) {
          return runTool(async () => {
            const { key, label } = resolveConversationKey(args);
            const identity = await runtime.getIdentity();
            const result = await identity.markTextConversationRead(key);
            return {
              title: `Marked ${result.updatedCount} message(s) as read`,
              output: `Marked ${result.updatedCount} message(s) as read in ${label}.`,
            };
          });
        },
      },
    },
  ];
}
