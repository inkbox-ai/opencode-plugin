import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson } from "../format.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const callArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  text: z.string().min(1).describe("Task text."),
  contextId: z.string().describe("Optional context to continue.").optional(),
  taskId: z.string().describe("Optional task requesting more input.").optional(),
  messageId: z.string().describe("Stable idempotency id.").optional(),
};

const checkArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  taskId: z.string().min(1).describe("Remote task id."),
  wait: z
    .boolean()
    .describe("Wait until the task reaches a final or input-required state.")
    .optional(),
};

const replyArgs = {
  cardUrl: z.string().url().describe("A2A Agent Card URL."),
  taskId: z.string().min(1).describe("Remote task id."),
  text: z.string().min(1).describe("Reply text."),
  messageId: z.string().describe("Stable idempotency id.").optional(),
};

type CallArgs = z.infer<z.ZodObject<typeof callArgs>>;
type CheckArgs = z.infer<z.ZodObject<typeof checkArgs>>;
type ReplyArgs = z.infer<z.ZodObject<typeof replyArgs>>;

async function clientFor(deps: ToolDeps): Promise<any> {
  const identity = await deps.runtime.getIdentity();
  const factory = (identity as any).a2aClient;
  if (typeof factory !== "function") {
    throw new Error("This A2A tool requires @inkbox/sdk with identity.a2aClient() support.");
  }
  return factory.call(identity);
}

export function a2aTools(deps: ToolDeps): RegisteredTool[] {
  const { config } = deps;
  return [
    {
      name: "inkbox_a2a_call",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description:
          "Send a task to an A2A 1.0 Agent Card. Keep the returned task and context ids for later checks or replies.",
        args: callArgs,
        async execute(args: CallArgs, ctx) {
          return runTool(async () => {
            await approveOutbound(ctx, config, {
              tool: "inkbox_a2a_call",
              recipients: [args.cardUrl],
              summary: `Send an A2A task to ${args.cardUrl}`,
              metadata: { cardUrl: args.cardUrl },
            });
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              return formatJson(
                await a2a.send(target, {
                  text: args.text,
                  contextId: args.contextId,
                  taskId: args.taskId,
                  messageId: args.messageId,
                }),
              );
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
    {
      name: "inkbox_a2a_check",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description: "Fetch an A2A task, or wait until it reaches a final or input-required state.",
        args: checkArgs,
        async execute(args: CheckArgs) {
          return runTool(async () => {
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              const task = args.wait
                ? await a2a.wait(target, args.taskId)
                : await a2a.getTask(target, args.taskId);
              return formatJson(task);
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
    {
      name: "inkbox_a2a_reply",
      group: "a2a",
      defaultEnabled: true,
      definition: {
        description: "Reply to a remote A2A task that requested more input.",
        args: replyArgs,
        async execute(args: ReplyArgs, ctx) {
          return runTool(async () => {
            await approveOutbound(ctx, config, {
              tool: "inkbox_a2a_reply",
              recipients: [args.cardUrl],
              summary: `Reply to A2A task ${args.taskId} at ${args.cardUrl}`,
              metadata: { cardUrl: args.cardUrl, taskId: args.taskId },
            });
            const a2a = await clientFor(deps);
            try {
              const target = await a2a.fetchCard(args.cardUrl);
              return formatJson(
                await a2a.send(target, {
                  taskId: args.taskId,
                  text: args.text,
                  messageId: args.messageId,
                }),
              );
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    },
  ];
}
