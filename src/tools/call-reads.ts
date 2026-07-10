import { z } from "zod";
import { runTool } from "../errors.js";
import { formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const listCallsArgs = {
  limit: z.number().int().min(1).max(200).describe("Maximum number of calls to return.").optional(),
  offset: z.number().int().min(0).describe("Pagination offset.").optional(),
};

const listCallTranscriptsArgs = {
  callId: z.string().describe("UUID of the call."),
};

type ListCallsArgs = z.infer<z.ZodObject<typeof listCallsArgs>>;
type ListCallTranscriptsArgs = z.infer<z.ZodObject<typeof listCallTranscriptsArgs>>;

// Read-side for the voice channel. Both tools are on by default since calls
// are often the slowest channel to keep up with and the agent will want to
// review missed-call history + transcripts.
export function callReadTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime } = deps;
  return [
    {
      name: "inkbox_list_calls",
      group: "calls",
      defaultEnabled: true,
      definition: {
        description:
          "List calls (inbound + outbound) for the configured Inkbox identity's phone number. Most recent first.",
        args: listCallsArgs,
        async execute(args: ListCallsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const calls = await identity.listCalls({
              limit: args.limit ?? 25,
              offset: args.offset ?? 0,
            });
            return formatWithHeader(`Returned ${calls.length} call(s).`, calls);
          });
        },
      },
    },
    {
      name: "inkbox_list_call_transcripts",
      group: "calls",
      defaultEnabled: true,
      definition: {
        description:
          "Fetch transcript segments for a single call by call UUID. Segments are ordered by seq; each segment includes the party (local/remote) and text.",
        args: listCallTranscriptsArgs,
        async execute(args: ListCallTranscriptsArgs, _ctx) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const segments = await identity.listTranscripts(args.callId);
            return formatWithHeader(
              `Returned ${segments.length} transcript segment(s) for call ${args.callId}.`,
              segments,
            );
          });
        },
      },
    },
  ];
}
