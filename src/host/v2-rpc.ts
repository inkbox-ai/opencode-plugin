import { createHash } from "node:crypto";
import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import type { ResolvedConfig } from "../config.js";
import { gatewayHome } from "../gateway/state.js";

export const TurnPolicy = z.object({
  sessionID: z.string(),
  messageID: z.string(),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
});
export type TurnPolicy = z.infer<typeof TurnPolicy>;

export const InkboxHost = Rpc.define({
  id: "inkbox.host",
  events: {},
  methods: {
    hello: {
      input: z.object({}),
      output: z.object({
        version: z.literal(1),
        instance: z.string(),
        installation: z.string(),
        stateProbe: z.string().optional(),
        configuration: z.string(),
        tools: z.array(z.string()),
      }),
    },
    prepare: { input: TurnPolicy, output: z.object({ ready: z.literal(true) }) },
  },
});

export function configurationKey(config: ResolvedConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        identity: config.identity,
        baseUrl: config.baseUrl,
        home: gatewayHome(),
        slack: config.gateway.slackEnabled,
        imessage: config.gateway.imessageThreadedReplies,
      }),
    )
    .digest("hex");
}
