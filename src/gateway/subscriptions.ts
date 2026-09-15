import type { AgentIdentity } from "@inkbox/sdk";
import { IncomingCallAction } from "@inkbox/sdk";
import { inkboxErrorMessage } from "../errors.js";
import { reconcileIdentitySubscription } from "../identity-subscription.js";
import type { GatewayDeps } from "./types.js";

// Path (under the public URL) all gateway webhook subscriptions target.
export const WEBHOOK_PATH = "/webhook";
// Path Inkbox connects to for inbound-call audio when voice is enabled.
export const CALL_MEDIA_WS_PATH = "/phone/media/ws";

export const MAILBOX_EVENT_TYPES = ["message.received", "message.bounced", "message.failed"];
export const PHONE_EVENT_TYPES = [
  "text.received",
  "text.delivery_failed",
  "text.delivery_unconfirmed",
];
export const IMESSAGE_EVENT_TYPES = [
  "imessage.received",
  "imessage.reaction_received",
  "imessage.delivery_failed",
];
export const A2A_EVENT_TYPES = [
  "a2a.task.created",
  "a2a.task.message",
  "a2a.task.canceled",
  "a2a.sent_task.updated",
];
export const CALL_EVENT_TYPES = ["call.ended"];
export interface ReconcileResult {
  created: number;
  updated: number;
  unchanged: number;
  // One-time signing key minted when the first subscription is created for
  // an identity that had none. Callers must persist it (INKBOX_SIGNING_KEY);
  // the API never returns it again.
  signingKey?: string;
}

function invalidPublicUrlError(): Error {
  return new Error(
    "Gateway public URL must be an http(s) URL. " +
      "Check gateway.publicUrl (or INKBOX_PUBLIC_URL) or let the tunnel provide one.",
  );
}

export function normalizePublicUrl(publicUrl: string): string {
  const base = publicUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    if (!/^https?:\/\//i.test(base)) throw new Error("missing HTTP(S) scheme");
    parsed = new URL(base);
  } catch {
    throw invalidPublicUrlError();
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw invalidPublicUrlError();
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Reconcile notifications without requiring provisioned channels. */
export async function reconcileSubscriptions(
  deps: GatewayDeps,
  publicUrl: string,
): Promise<ReconcileResult> {
  const base = normalizePublicUrl(publicUrl);
  const webhookUrl = `${base}${WEBHOOK_PATH}`;

  // Deployments that provision subscriptions ahead of time have a fixed
  // destination, and an API key that may not be allowed to change it.
  if (deps.config.gateway.skipWebhookReconcile) {
    deps.logger.info("subscriptions.skipped", { expectedUrl: webhookUrl });
    return { created: 0, updated: 0, unchanged: 0 };
  }

  const identity = await deps.inkbox.getIdentity();
  const client = await deps.inkbox.getClient();

  const result: ReconcileResult = { created: 0, updated: 0, unchanged: 0 };

  const reconciled = await reconcileIdentitySubscription(client, identity.id, webhookUrl, [
    ...MAILBOX_EVENT_TYPES,
    ...PHONE_EVENT_TYPES,
    ...IMESSAGE_EVENT_TYPES,
    ...CALL_EVENT_TYPES,
    ...A2A_EVENT_TYPES,
  ]);
  result[reconciled.action] += 1;
  if (reconciled.signingKey) {
    result.signingKey = reconciled.signingKey;
    deps.logger.warn(
      "A webhook signing key was created. Save it as INKBOX_SIGNING_KEY before restarting.",
    );
  }

  if (deps.config.gateway.voice.enabled) {
    await wireIncomingCalls(deps, identity, base, webhookUrl);
  }

  return result;
}

async function wireIncomingCalls(
  deps: GatewayDeps,
  identity: AgentIdentity,
  base: string,
  webhookUrl: string,
): Promise<void> {
  // Calls can arrive on the dedicated number or the shared iMessage line;
  // with neither there is nothing to wire.
  if (!identity.phoneNumber && !identity.imessageEnabled) {
    deps.logger.warn(
      "voice is enabled but the identity has no phone number and iMessage is disabled; " +
        "skipping incoming-call wiring",
    );
    return;
  }
  const hosted = deps.config.phoneVoiceStack === "inkbox_voice_ai";
  // https -> wss (http -> ws in local dev); local stacks receive call audio here.
  const wsUrl = `${base.replace(/^http/, "ws")}${CALL_MEDIA_WS_PATH}`;
  try {
    // Identity-scoped config covers the dedicated number and any shared
    // iMessage line in one row. auto_accept opens the audio WS directly.
    const action = hosted
      ? ({
          incomingCallAction: IncomingCallAction.HOSTED_AGENT,
          clientWebsocketUrl: null,
          incomingCallWebhookUrl: null,
        } as unknown as Parameters<AgentIdentity["setIncomingCallAction"]>[0])
      : {
          incomingCallAction: IncomingCallAction.AUTO_ACCEPT,
          clientWebsocketUrl: wsUrl,
          incomingCallWebhookUrl: webhookUrl,
        };
    await identity.setIncomingCallAction(action);
    deps.logger.info(
      hosted ? "incoming calls use Inkbox Voice AI" : "incoming-call action set to auto-accept",
      hosted ? undefined : { clientWebsocketUrl: wsUrl },
    );
  } catch (err) {
    throw new Error(`Failed to set the incoming-call action: ${inkboxErrorMessage(err)}`);
  }
}
