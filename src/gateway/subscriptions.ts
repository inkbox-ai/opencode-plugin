import type { AgentIdentity } from "@inkbox/sdk";
import { IncomingCallAction } from "@inkbox/sdk";
import { inkboxErrorMessage } from "../errors.js";
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

// Exactly one owner id per subscription, matching the API contract.
type SubscriptionOwner =
  | { mailboxId: string }
  | { phoneNumberId: string }
  | { agentIdentityId: string };

function sameEventTypes(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every((e) => setB.has(e));
}

function eventFamilies(eventTypes: string[]): Set<string> {
  return new Set(eventTypes.map((eventType) => eventType.split(".", 1)[0]));
}

function sameWebhookPath(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function isUnsupportedA2AEventTypes(err: unknown): boolean {
  const message = inkboxErrorMessage(err);
  return (
    A2A_EVENT_TYPES.some((eventType) => message.includes(eventType)) &&
    (message.includes("Validation error (422)") ||
      message.includes("does not belong to any known channel"))
  );
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

/**
 * Reconcile the identity's webhook subscriptions with this gateway's public
 * URL: mailbox message events, phone text events (when a number is
 * provisioned), and iMessage events (when enabled). Idempotent — existing
 * subscriptions on our URL are updated in place only when their event types
 * differ, and subscriptions pointing anywhere else are never touched. When
 * voice is enabled, also points the identity's incoming-call action at the
 * gateway's call-audio WebSocket.
 */
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

  async function reconcileOwner(
    kind: string,
    owner: SubscriptionOwner,
    eventTypes: string[],
    subscriptionUrl = webhookUrl,
  ): Promise<void> {
    try {
      const existing = await client.webhooks.subscriptions.list(owner);
      const desiredFamilies = eventFamilies(eventTypes);
      const belongsToDesiredChannel = (sub: { eventTypes: string[] }) =>
        [...eventFamilies(sub.eventTypes)].some((family) => desiredFamilies.has(family));
      const ours = existing.find(
        (sub) => sub.url === subscriptionUrl && belongsToDesiredChannel(sub),
      );
      const staleOurs = existing.filter(
        (sub) =>
          sub.url !== subscriptionUrl &&
          sameWebhookPath(sub.url, subscriptionUrl) &&
          [...eventFamilies(sub.eventTypes)].some((family) => desiredFamilies.has(family)),
      );
      if (!ours) {
        const created = await client.webhooks.subscriptions.create({
          ...owner,
          url: subscriptionUrl,
          eventTypes,
        });
        result.created += 1;
        if (created.signingKey) {
          result.signingKey ??= created.signingKey;
          deps.logger.warn(
            "Inkbox minted a webhook signing key for this identity (shown once). " +
              "Save it as INKBOX_SIGNING_KEY or webhook signature verification will fail.",
            { kind, subscriptionId: created.id },
          );
        }
        deps.logger.info("created webhook subscription", { kind, subscriptionId: created.id });
      } else if (sameEventTypes(ours.eventTypes, eventTypes)) {
        result.unchanged += 1;
      } else {
        await client.webhooks.subscriptions.update(ours.id, { eventTypes });
        result.updated += 1;
        deps.logger.info("updated webhook subscription event types", {
          kind,
          subscriptionId: ours.id,
        });
      }
      for (const stale of staleOurs) {
        await client.webhooks.subscriptions.delete(stale.id);
        deps.logger.info("removed stale webhook subscription", {
          kind,
          subscriptionId: stale.id,
        });
      }
    } catch (err) {
      if (kind === "a2a" && isUnsupportedA2AEventTypes(err)) {
        deps.logger.warn(
          "Inkbox API does not support A2A webhook events yet; " + "skipping the A2A subscription",
        );
        return;
      }
      throw new Error(
        `Failed to reconcile ${kind} webhook subscription for ${subscriptionUrl}: ` +
          inkboxErrorMessage(err),
      );
    }
  }

  if (identity.mailbox) {
    await reconcileOwner("mailbox", { mailboxId: identity.mailbox.id }, MAILBOX_EVENT_TYPES);
  }
  if (identity.phoneNumber) {
    await reconcileOwner("phone", { phoneNumberId: identity.phoneNumber.id }, PHONE_EVENT_TYPES);
  }
  await reconcileOwner("a2a", { agentIdentityId: identity.id }, A2A_EVENT_TYPES);
  if (identity.imessageEnabled) {
    await reconcileOwner("imessage", { agentIdentityId: identity.id }, IMESSAGE_EVENT_TYPES);
  }

  if (identity.phoneNumber || identity.imessageEnabled) {
    await reconcileOwner("calls", { agentIdentityId: identity.id }, CALL_EVENT_TYPES);
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
