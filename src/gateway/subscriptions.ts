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
export const IDENTITY_EVENT_TYPES = [...IMESSAGE_EVENT_TYPES, ...A2A_EVENT_TYPES];

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

function isUnsupportedA2AEventTypes(err: unknown): boolean {
  const message = inkboxErrorMessage(err);
  return (
    A2A_EVENT_TYPES.some((eventType) => message.includes(eventType)) &&
    (message.includes("Validation error (422)") ||
      message.includes("does not belong to any known channel"))
  );
}

function normalizePublicUrl(publicUrl: string): string {
  const base = publicUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new Error(
      `Gateway public URL must be an http(s) URL, got '${publicUrl}'. ` +
        "Check gateway.publicUrl (or INKBOX_PUBLIC_URL) or let the tunnel provide one.",
    );
  }
  return base;
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
  const identity = await deps.inkbox.getIdentity();
  const client = await deps.inkbox.getClient();

  const result: ReconcileResult = { created: 0, updated: 0, unchanged: 0 };

  async function reconcileOwner(
    kind: string,
    owner: SubscriptionOwner,
    eventTypes: string[],
  ): Promise<void> {
    try {
      const existing = await client.webhooks.subscriptions.list(owner);
      const ours = existing.find((sub) => sub.url === webhookUrl);
      if (!ours) {
        const created = await client.webhooks.subscriptions.create({
          ...owner,
          url: webhookUrl,
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
    } catch (err) {
      if (kind === "identity" && isUnsupportedA2AEventTypes(err)) {
        const fallbackEventTypes = eventTypes.filter(
          (eventType) => !A2A_EVENT_TYPES.includes(eventType),
        );
        deps.logger.warn(
          "Inkbox API does not support A2A webhook events yet; " +
            (fallbackEventTypes.length
              ? "reconciling the identity subscription without A2A events"
              : "skipping the A2A-only identity subscription"),
        );
        if (fallbackEventTypes.length) {
          await reconcileOwner(kind, owner, fallbackEventTypes);
        }
        return;
      }
      throw new Error(
        `Failed to reconcile ${kind} webhook subscription for ${webhookUrl}: ` +
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
  await reconcileOwner(
    "identity",
    { agentIdentityId: identity.id },
    identity.imessageEnabled ? IDENTITY_EVENT_TYPES : A2A_EVENT_TYPES,
  );

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
  // https -> wss (http -> ws in local dev); Inkbox dials this URL with call audio.
  const wsUrl = `${base.replace(/^http/, "ws")}${CALL_MEDIA_WS_PATH}`;
  try {
    // Identity-scoped config covers the dedicated number and any shared
    // iMessage line in one row. auto_accept opens the audio WS directly.
    await identity.setIncomingCallAction({
      incomingCallAction: IncomingCallAction.AUTO_ACCEPT,
      clientWebsocketUrl: wsUrl,
      incomingCallWebhookUrl: webhookUrl,
    });
    deps.logger.info("incoming-call action set to auto-accept", { clientWebsocketUrl: wsUrl });
  } catch (err) {
    throw new Error(`Failed to set the incoming-call action: ${inkboxErrorMessage(err)}`);
  }
}
