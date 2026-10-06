import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { preflightNativeIMessage } from "../imessage-native.js";
import { SLACK_SUBSCRIPTION_EVENTS } from "../slack.js";
import { createStateStore, type StateStore } from "./state.js";

export interface ChannelFinding {
  severity: "info" | "warning" | "error";
  message: string;
}

/** Read-only, count/status-only diagnostics. Never reconcile or send from doctor. */
export async function channelReadiness(
  config: ResolvedConfig,
  runtime: InkboxRuntime,
  store: StateStore = createStateStore(),
): Promise<ChannelFinding[]> {
  const findings: ChannelFinding[] = [];
  const add = (severity: ChannelFinding["severity"], message: string) =>
    findings.push({ severity, message });
  if (!config.gateway.imessageThreadedReplies) add("info", "Native iMessage replies: disabled.");
  else {
    try {
      const identity = await runtime.getIdentity();
      if (!identity.imessageEnabled)
        add("error", "Native iMessage replies: identity is not provisioned for iMessage.");
      else if (
        typeof identity.getIMessage !== "function" ||
        typeof identity.getIMessageThread !== "function"
      )
        add("error", "Native iMessage replies: installed SDK lacks native source/thread reads.");
      else {
        const target = store
          .listTurns()
          .sort((a, b) => b.createdAt - a.createdAt)
          .find((turn) => turn.replyTarget?.imessageSource)?.replyTarget;
        if (!target)
          add(
            "warning",
            "Native iMessage replies: SDK supports targeting; backend remains unverified until an admitted source is available.",
          );
        else {
          await preflightNativeIMessage(identity, target, store);
          add(
            "info",
            "Native iMessage replies: source conversation and bounded native endpoint verified; this is not delivery proof.",
          );
        }
      }
    } catch {
      add(
        "error",
        "Native iMessage replies: source/backend verification unavailable; no send was attempted.",
      );
    }
  }
  if (!config.gateway.slackEnabled) add("info", "Slack: disabled.");
  else {
    try {
      const identity = await runtime.getIdentity();
      const client = await runtime.getClient();
      if (
        typeof client.slack?.listConnections !== "function" ||
        typeof client.webhooks?.subscriptions?.list !== "function"
      )
        add("error", "Slack: installed SDK lacks connection/subscription inspection.");
      else {
        const connections = (await client.slack.listConnections(identity.id)).connections.filter(
          (row) => row.identityId === identity.id && row.workspaceId && row.status === "connected",
        );
        if (!connections.length)
          add("error", "Slack: no connected workspace owned by the configured identity.");
        else
          add(
            "info",
            `Slack: ${connections.length} connected workspace(s) owned by the configured identity.`,
          );
        const url = config.gateway.publicUrl?.replace(/\/+$/, "");
        if (!url)
          add(
            "warning",
            "Slack webhook route: public URL is not available to doctor; subscription readiness is unverified.",
          );
        else {
          const webhook = `${url}/webhook`;
          const subscriptions = await client.webhooks.subscriptions.list({
            agentIdentityId: identity.id,
            scope: "identity",
            url: webhook,
          });
          const covered = new Set(
            subscriptions
              .filter(
                (row) =>
                  row.agentIdentityId === identity.id &&
                  row.url === webhook &&
                  row.status === "active",
              )
              .flatMap((row) => row.eventTypes),
          );
          const missing = SLACK_SUBSCRIPTION_EVENTS.filter((event) => !covered.has(event));
          add(
            missing.length ? "error" : "info",
            missing.length
              ? `Slack webhook route: ${missing.length} required event type(s) lack active identity-scoped coverage.`
              : "Slack webhook route: required event types have active identity-scoped coverage.",
          );
        }
      }
    } catch {
      add(
        "error",
        "Slack: connection/subscription inspection unavailable; configuration was not changed.",
      );
    }
  }
  return findings;
}
