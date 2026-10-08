import { createHash } from "node:crypto";
import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson } from "../format.js";
import { approveOutbound } from "../permissions.js";
import { ownSlackConnection, slackText } from "../slack.js";
import { slackMrkdwn } from "../slack-style.js";
import { uploadSlackFile } from "../slack-upload.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const text = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "NUL characters are not allowed.");
const page = { cursor: text.optional(), limit: z.number().int().min(1).max(100).optional() };
const specs = [
  { name: "list_connections", description: "List this identity's Slack connections.", args: {} },
  {
    name: "list_conversations",
    description: "List accessible Slack conversations. Follow nextCursor.",
    args: { connectionId: text, ...page },
  },
  {
    name: "list_messages",
    description: "Read one Slack conversation or native thread. Follow nextCursor.",
    args: {
      connectionId: text,
      conversationId: text,
      threadTs: text.nullable().optional(),
      ...page,
    },
  },
  {
    name: "search",
    description:
      "Search retained Slack text, not complete workspace history or attachments. Follow nextCursor even on empty pages.",
    args: { q: text, connectionId: text.optional(), conversationId: text.optional(), ...page },
  },
  {
    name: "send_message",
    description:
      "Send an explicitly requested Slack message. Ordinary responses are automatic. Reuse idempotencyKey for retries of the same send. Inspect sending/unknown outcomes with get_action; never blindly resend.",
    args: {
      connectionId: text,
      conversationId: text,
      text: text.max(12000),
      threadTs: text.nullable().optional(),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    },
  },
  {
    name: "upload_file",
    description:
      "Upload an actual local file to Slack. Supply filePath, never invented base64 or a delivery claim. Active-conversation uploads retain the original thread. Inspect unknown results with get_operation; never resend an uncertain upload.",
    args: {
      connectionId: text,
      conversationId: text,
      filePath: text,
      filename: text.max(255).optional(),
      title: text.max(255).optional(),
      initialComment: text.max(12000).optional(),
      threadTs: text.nullable().optional(),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    },
  },
  {
    name: "get_operation",
    description: "Inspect a Slack file/progress operation without repeating its effects.",
    args: { connectionId: text, operationId: text },
  },
  {
    name: "get_action",
    description:
      "Inspect a Slack send action; an unknown outcome must not cause duplicate sending.",
    args: { connectionId: text, actionId: text },
  },
] as const;
export function slackTools({ runtime, config, opencode }: ToolDeps): RegisteredTool[] {
  if (!config.gateway?.slackEnabled) return [];
  return specs.map((spec) => ({
    name: `inkbox_slack_${spec.name}`,
    group: "slack",
    defaultEnabled: true,
    definition: {
      description: spec.description,
      args: spec.args,
      async execute(raw, ctx) {
        return runTool(async () => {
          if (!config.gateway?.slackEnabled) throw new Error("Slack is disabled.");
          const args = z.object(spec.args).strict().parse(raw) as Record<string, any>;
          const [client, identity] = await Promise.all([
            runtime.getClient(),
            runtime.getIdentity(),
          ]);
          if (args.connectionId) await ownSlackConnection(client, identity.id, args.connectionId);
          const options = { cursor: args.cursor, limit: args.limit };
          let result: unknown;
          switch (spec.name) {
            case "list_connections":
              result = await client.slack.listConnections(identity.id);
              break;
            case "list_conversations":
              result = await client.slack.listConversations(args.connectionId, options);
              break;
            case "list_messages":
              result = await client.slack.listMessages(args.connectionId, args.conversationId, {
                ...options,
                threadTs: args.threadTs,
              });
              break;
            case "search":
              result = await client.slack.searchMessages({
                identityId: identity.id,
                q: args.q,
                connectionId: args.connectionId,
                conversationId: args.conversationId,
                ...options,
              });
              break;
            case "send_message":
              args.text = slackMrkdwn(args.text);
              slackText(args.text);
              await approveOutbound(ctx, config, {
                tool: "inkbox_slack_send_message",
                recipients: [`slack:${args.connectionId}:${args.conversationId}`],
                summary: "Send a Slack message",
                metadata: { textChars: args.text.length },
              });
              await ownSlackConnection(client, identity.id, args.connectionId);
              result = await client.slack.sendMessage(args.connectionId, {
                conversationId: args.conversationId,
                text: args.text,
                threadTs: args.threadTs,
                idempotencyKey: args.idempotencyKey,
              });
              break;
            case "upload_file":
              result = await uploadSlackFile(
                {
                  runtime,
                  opencode,
                  enabled: () => config.gateway.slackEnabled,
                  approve: (file) =>
                    approveOutbound(ctx, config, {
                      tool: "inkbox_slack_upload_file",
                      recipients: [`slack:${args.connectionId}:${args.conversationId}`],
                      summary: `Upload ${file.filename} to Slack`,
                      patterns: [
                        `slack-file:${createHash("sha256")
                          .update(
                            JSON.stringify([args.connectionId, args.conversationId, file.path]),
                          )
                          .digest("hex")}`,
                      ],
                      metadata: {
                        filename: file.filename,
                        filePath: file.path,
                        conversationId: args.conversationId,
                      },
                    }),
                },
                args as any,
                ctx,
              );
              break;
            case "get_operation":
              result = await client.slack.getOperation(args.connectionId, args.operationId);
              break;
            case "get_action":
              result = await client.slack.getAction(args.connectionId, args.actionId);
              break;
          }
          return formatJson(result);
        });
      },
    },
  }));
}
