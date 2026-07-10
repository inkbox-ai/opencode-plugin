import { CallOrigin } from "@inkbox/sdk";
import { z } from "zod";
import { runTool } from "../errors.js";
import { approveOutbound } from "../permissions.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const placeCallArgs = {
  toNumber: z.string().describe("Recipient phone number in E.164 format."),
  origination: z
    .enum(["dedicated_number", "shared_imessage_number"])
    .describe(
      'Which line to call from. Use "dedicated_number" to call from your own phone number (the same line SMS/voice conversations use). Use "shared_imessage_number" to call someone over the shared iMessage line you are already messaging them on — this only works if they are connected to you over iMessage (otherwise the call is rejected). If omitted, it is resolved automatically: the only available line, or the dedicated number when both are available.',
    )
    .optional(),
  purpose: z
    .string()
    .describe(
      "Why this call is being placed. Loaded into the live call so it opens with context instead of a generic greeting. If no topic was given, say the user asked for a general call.",
    )
    .optional(),
  openingMessage: z
    .string()
    .describe("Optional exact or near-exact first thing to say when the call connects.")
    .optional(),
  context: z
    .string()
    .describe("Optional background facts the voice agent may need after the opening.")
    .optional(),
  clientWebsocketUrl: z
    .string()
    .describe(
      "Optional WebSocket URL (wss://...) that Inkbox will connect to for the call stream. Omit to use the callWebsocketUrl configured for the plugin.",
    )
    .optional(),
};

// Fold call context onto the media WebSocket URL as query params. This is the
// only channel that survives to the call bridge, which may run in a separate
// process, so it reads purpose/opening/context from the upgrade request URL.
function decorateCallUrl(
  rawUrl: string,
  ctx: { purpose?: string; openingMessage?: string; context?: string },
): string {
  try {
    const url = new URL(rawUrl);
    if (ctx.purpose) url.searchParams.set("purpose", ctx.purpose);
    if (ctx.openingMessage) url.searchParams.set("opening_message", ctx.openingMessage);
    if (ctx.context) url.searchParams.set("context", ctx.context);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

type PlaceCallArgs = z.infer<z.ZodObject<typeof placeCallArgs>>;

// Pick which line an outbound call originates from: an explicit choice always
// wins; otherwise the only available line (dedicated number vs shared
// iMessage); when both exist, default to the dedicated number — the open line
// that can reach anyone. Undefined when neither line exists.
function resolveCallOrigination(
  identity: { phoneNumber?: unknown; imessageEnabled?: boolean },
  explicit: string,
): "dedicated_number" | "shared_imessage_number" | undefined {
  const choice = explicit.trim().toLowerCase();
  if (choice === "dedicated_number" || choice === "shared_imessage_number") {
    return choice;
  }
  const hasNumber = identity.phoneNumber != null;
  const imessageEnabled = Boolean(identity.imessageEnabled);
  if (hasNumber) {
    return "dedicated_number";
  }
  if (imessageEnabled) {
    return "shared_imessage_number";
  }
  return undefined;
}

// Outbound voice — initiates a call to the given E.164 recipient over either
// the identity's dedicated phone number or the shared iMessage line. Inkbox
// dials out and bridges the live call audio to a WebSocket URL, supplied
// per-call or via the plugin's callWebsocketUrl option.
export function placeCallTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, config } = deps;
  return [
    {
      name: "inkbox_place_call",
      group: "calls",
      defaultEnabled: false,
      definition: {
        description:
          "Place an outbound voice call. Calls can go out over two lines: your own dedicated phone number, or the shared Inkbox iMessage line you are already messaging the recipient on. Match the channel you're talking on — call SMS/phone contacts from your dedicated number, and call an iMessage contact over the shared iMessage line (set `origination` accordingly). Returns the queued call's id + status + origination + rate-limit info.",
        args: placeCallArgs,
        async execute(args: PlaceCallArgs, ctx) {
          return runTool(async () => {
            // Resolve the audio bridge before asking for approval so the
            // approver sees exactly where the call's media will stream.
            const clientWebsocketUrl = args.clientWebsocketUrl ?? config.callWebsocketUrl;
            if (!clientWebsocketUrl) {
              throw new Error(
                "No call WebSocket configured. Pass clientWebsocketUrl (wss://...) or set the callWebsocketUrl plugin option / INKBOX_CALL_WEBSOCKET_URL so Inkbox has an audio bridge to connect to.",
              );
            }
            if (!/^wss?:\/\//.test(clientWebsocketUrl)) {
              throw new Error("clientWebsocketUrl must be a ws:// or wss:// URL.");
            }
            await approveOutbound(ctx, config, {
              tool: "inkbox_place_call",
              recipients: [args.toNumber],
              summary: `Place voice call to ${args.toNumber} (audio bridge: ${clientWebsocketUrl})`,
              metadata: {
                origination: args.origination ?? "auto",
                clientWebsocketUrl,
                ...(args.purpose ? { purpose: args.purpose } : {}),
              },
            });

            const decoratedUrl = decorateCallUrl(clientWebsocketUrl, {
              purpose: args.purpose,
              openingMessage: args.openingMessage,
              context: args.context,
            });
            const identity = await runtime.getIdentity();
            // Resolve the outbound line (dedicated number vs shared iMessage line).
            const origination = resolveCallOrigination(identity, args.origination ?? "");
            if (!origination) {
              throw new Error(
                "This identity can't place calls: it has no dedicated phone number and iMessage is not enabled. Provision a number or enable iMessage first.",
              );
            }
            let call: Awaited<ReturnType<typeof identity.placeCall>>;
            try {
              call = await identity.placeCall({
                toNumber: args.toNumber,
                origination:
                  origination === "shared_imessage_number"
                    ? CallOrigin.SHARED_IMESSAGE_NUMBER
                    : CallOrigin.DEDICATED_NUMBER,
                clientWebsocketUrl: decoratedUrl,
              });
            } catch (error) {
              // A shared-line call to someone who isn't connected over iMessage
              // is rejected server-side; surface a legible reason to the agent.
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes("no_shared_connection")) {
                throw new Error(
                  "Can't place a shared iMessage-line call: this person isn't connected to you over iMessage yet. They need to message your iMessage number first. To call from your own phone number instead, set origination to \"dedicated_number\".",
                );
              }
              throw error;
            }
            // rateLimit is on the call response — surface it so the agent can
            // see remaining capacity before queueing more outbound calls.
            const remaining = call.rateLimit?.callsRemaining;
            return {
              title: `Call placed to ${args.toNumber}`,
              output:
                `Placed call id=${call.id} to=${args.toNumber} status=${call.status} origination=${origination}` +
                (remaining !== undefined ? ` callsRemaining=${remaining}` : ""),
            };
          });
        },
      },
    },
  ];
}
