import type { Inkbox, WebhookSubscription } from "@inkbox/sdk";

const RECEIVED = new Set(["message.received", "text.received", "imessage.received"]);

type ReconcileResult = {
  subscription: WebhookSubscription;
  action: "created" | "updated" | "unchanged";
  signingKey?: string;
};

function contextKey(value: WebhookSubscription["contextConfig"]): string {
  return JSON.stringify(
    value == null
      ? null
      : Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry != null)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [
              key,
              Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))),
            ]),
        ),
  ).replace(/^\{\}$/, "null");
}

/** Preserve event coverage; stale writes retry against the complete receiver set. */
export async function reconcileIdentitySubscription(
  client: Inkbox,
  identityId: string,
  url: string,
  events: readonly string[],
): Promise<ReconcileResult> {
  const desired = new Set(events);
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = (await client.webhooks.subscriptions.list({ agentIdentityId: identityId })).filter(
      (row) =>
        row.url === url &&
        (row.ownerIdentityId ?? row.agentIdentityId) === identityId &&
        row.status === "active",
    );
    const compatible = rows
      .filter((row) => {
        if (!row.hasAuthToken && row.authToken == null) return true;
        if (row.eventTypes.some((event) => desired.has(event))) {
          throw new Error(
            "Webhook receiver has conflicting delivery authentication; review its subscriptions.",
          );
        }
        return false;
      })
      .sort(
        (a, b) =>
          Number(b.agentIdentityId === identityId) - Number(a.agentIdentityId === identityId) ||
          a.id.localeCompare(b.id),
      );
    const contexts = new Set(
      compatible
        .filter((row) => row.eventTypes.some((event) => RECEIVED.has(event)))
        .map((row) => contextKey(row.contextConfig)),
    );
    if (contexts.size > 1)
      throw new Error(
        "Webhook receiver has conflicting context settings; review its subscriptions.",
      );
    const context = [...contexts][0] ?? "null";
    const covered = new Set(compatible.flatMap((row) => row.eventTypes));
    const missing = [...desired].filter((event) => !covered.has(event));
    if (missing.length === 0 && compatible[0])
      return { subscription: compatible[0], action: "unchanged" };
    const target = compatible.find((row) => contextKey(row.contextConfig) === context);
    try {
      if (target) {
        if (!Number.isSafeInteger(target.revision) || target.revision < 1) {
          throw new Error("Webhook revision is unavailable; upgrade the Inkbox SDK and retry.");
        }
        const subscription = await client.webhooks.subscriptions.update(target.id, {
          eventTypes: [...new Set([...target.eventTypes, ...missing])].sort(),
          expectedRevision: target.revision,
        });
        return { subscription, action: "updated" };
      }
      const subscription = await client.webhooks.subscriptions.create({
        agentIdentityId: identityId,
        url,
        eventTypes: missing.sort(),
        ...(context !== "null" ? { contextConfig: JSON.parse(context) } : {}),
      });
      return {
        subscription,
        action: "created",
        ...(subscription.signingKey ? { signingKey: subscription.signingKey } : {}),
      };
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if ((status !== 404 && status !== 409) || attempt === 3) throw error;
    }
  }
  throw new Error("Webhook subscriptions changed repeatedly; retry setup.");
}
