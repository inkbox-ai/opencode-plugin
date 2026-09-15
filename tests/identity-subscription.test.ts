import type { Inkbox, WebhookSubscription } from "@inkbox/sdk";
import { describe, expect, it, vi } from "vitest";
import { reconcileIdentitySubscription } from "../src/identity-subscription.js";

const URL = "https://agent.example/webhook";
const EVENTS = [
  "message.received",
  "text.received",
  "imessage.received",
  "call.ended",
  "a2a.task.created",
];
function row(extra: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: "one",
    organizationId: "org-example",
    agentIdentityId: "agent",
    ownerIdentityId: "agent",
    mailboxId: null,
    phoneNumberId: null,
    url: URL,
    eventTypes: [...EVENTS],
    status: "active",
    revision: 1,
    hasAuthToken: false,
    authToken: null,
    contextConfig: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}
function harness(initial: WebhookSubscription[] = []) {
  const rows = [...initial];
  const conflict = () => Object.assign(new Error("changed"), { statusCode: 409 });
  let race: (() => void) | undefined;
  const subscriptions = {
    list: vi.fn(async (options: unknown) => {
      expect(options).toEqual({ agentIdentityId: "agent" });
      return rows.map((entry) => ({ ...entry, eventTypes: [...entry.eventTypes] }));
    }),
    create: vi.fn(
      async (options: { eventTypes: string[]; agentIdentityId: string; url: string }) => {
        if (race) {
          const action = race;
          race = undefined;
          action();
          throw conflict();
        }
        const created = { ...row(options), signingKey: null };
        rows.push(created);
        return created;
      },
    ),
    update: vi.fn(
      async (id: string, options: { eventTypes: string[]; expectedRevision: number }) => {
        if (race) {
          const action = race;
          race = undefined;
          action();
          throw conflict();
        }
        const target = rows.find((entry) => entry.id === id);
        if (!target) throw new Error("Unknown test subscription");
        expect(options.expectedRevision).toBe(target.revision);
        target.eventTypes = options.eventTypes;
        target.revision++;
        return target;
      },
    ),
    delete: vi.fn(async () => {
      throw new Error("Must not delete subscriptions");
    }),
  };
  return {
    rows,
    subscriptions,
    conflict,
    race: (fn: () => void) => {
      race = fn;
    },
    run: () =>
      reconcileIdentitySubscription(
        { webhooks: { subscriptions } } as unknown as Inkbox,
        "agent",
        URL,
        EVENTS,
      ),
  };
}

describe("identity receiver reconciliation", () => {
  it("creates one receiver without resources and is stable across restarts", async () => {
    const h = harness();
    await h.run();
    await h.run();
    expect(h.subscriptions.create).toHaveBeenCalledWith({
      agentIdentityId: "agent",
      url: URL,
      eventTypes: [...EVENTS].sort(),
    });
    expect(h.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(h.subscriptions.update).not.toHaveBeenCalled();
  });
  it("preserves a superset and existing context without writes", async () => {
    const h = harness([
      row({
        eventTypes: [...EVENTS, "message.sent"],
        contextConfig: { email: { mode: "count", count: 3 } },
      }),
    ]);
    expect((await h.run()).action).toBe("unchanged");
    expect(h.subscriptions.update).not.toHaveBeenCalled();
  });
  it("adds missing events conditionally without removing unknown selections", async () => {
    const h = harness([row({ eventTypes: ["message.received", "message.sent"], revision: 7 })]);
    await h.run();
    expect(h.subscriptions.update).toHaveBeenCalledWith("one", {
      expectedRevision: 7,
      eventTypes: [...EVENTS, "message.sent"].sort(),
    });
  });
  it("adopts compatible multi-row legacy coverage without consolidation", async () => {
    const h = harness([
      row({ id: "mail", agentIdentityId: null, eventTypes: EVENTS.slice(0, 1) }),
      row({ id: "rest", eventTypes: EVENTS.slice(1) }),
    ]);
    await h.run();
    expect(h.subscriptions.create).not.toHaveBeenCalled();
    expect(h.subscriptions.update).not.toHaveBeenCalled();
    expect(h.subscriptions.delete).not.toHaveBeenCalled();
  });
  it("adds only events not covered by another receiver row", async () => {
    const h = harness([
      row({ id: "mail", agentIdentityId: null, eventTypes: ["message.received"] }),
      row({ id: "rest", eventTypes: ["call.ended"] }),
    ]);
    await h.run();
    expect(h.subscriptions.update).toHaveBeenCalledWith("rest", {
      expectedRevision: 1,
      eventTypes: EVENTS.slice(1).sort(),
    });
  });
  it("never changes another URL, query, or identity", async () => {
    const h = harness([
      row({ id: "other", url: "https://other.example/webhook" }),
      row({ id: "query", url: `${URL}?receiver=other` }),
      row({ id: "foreign", ownerIdentityId: "foreign" }),
    ]);
    await h.run();
    expect(h.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(h.subscriptions.update).not.toHaveBeenCalled();
    expect(h.subscriptions.delete).not.toHaveBeenCalled();
  });
  it.each([{ hasAuthToken: true }, { authToken: "synthetic-delivery-auth" }])(
    "rejects conflicting/unreadable authentication: %j",
    async (auth) => {
      const h = harness([row(auth)]);
      await expect(h.run()).rejects.toThrow("authentication");
      expect(h.subscriptions.create).not.toHaveBeenCalled();
      expect(h.subscriptions.update).not.toHaveBeenCalled();
    },
  );
  it("rejects conflicting received-event context", async () => {
    const h = harness([
      row({
        id: "mail",
        eventTypes: ["message.received"],
        contextConfig: { email: { mode: "count", count: 3 } },
      }),
      row({ id: "rest", eventTypes: EVENTS.slice(1) }),
    ]);
    await expect(h.run()).rejects.toThrow("context");
    expect(h.subscriptions.update).not.toHaveBeenCalled();
  });
  it("allows context only on rows with context-bearing events", async () => {
    const h = harness([
      row({
        id: "received",
        eventTypes: EVENTS.slice(0, 3),
        contextConfig: { email: { mode: "count", count: 3 } },
      }),
      row({ id: "other", eventTypes: EVENTS.slice(3) }),
    ]);
    expect((await h.run()).action).toBe("unchanged");
  });
  it("recomputes the union after a revision conflict", async () => {
    const first = row({ eventTypes: ["message.received"] });
    const h = harness([first]);
    h.race(() => {
      first.eventTypes.push("message.sent");
      first.revision++;
    });
    await h.run();
    expect(h.subscriptions.update).toHaveBeenLastCalledWith("one", {
      expectedRevision: 2,
      eventTypes: [...EVENTS, "message.sent"].sort(),
    });
  });
  it("adopts a concurrent create instead of replacing the winner", async () => {
    const h = harness();
    h.race(() => h.rows.push(row({ id: "winner" })));
    expect((await h.run()).subscription.id).toBe("winner");
    expect(h.subscriptions.update).not.toHaveBeenCalled();
  });
  it("never sends an unconditional update without revision", async () => {
    const h = harness([row({ eventTypes: ["message.received"], revision: 0 })]);
    await expect(h.run()).rejects.toThrow("revision");
    expect(h.subscriptions.update).not.toHaveBeenCalled();
  });
  it("bounds conflict retries", async () => {
    const h = harness([row({ eventTypes: ["message.received"] })]);
    h.subscriptions.update.mockRejectedValue(h.conflict());
    await expect(h.run()).rejects.toThrow("changed repeatedly");
    expect(h.subscriptions.update).toHaveBeenCalledTimes(4);
  });
});

it("conditionally extends a legacy receiver without duplicating coverage", async () => {
  const h = harness([
    row({ id: "legacy", agentIdentityId: null, eventTypes: ["message.received"] }),
  ]);
  await h.run();
  expect(h.subscriptions.create).not.toHaveBeenCalled();
  expect(h.subscriptions.update).toHaveBeenCalledWith("legacy", {
    expectedRevision: 1,
    eventTypes: [...EVENTS].sort(),
  });
});

it("re-reads sibling coverage after a revision conflict", async () => {
  const h = harness([row({ eventTypes: ["message.received"] })]);
  h.race(() => h.rows.push(row({ id: "sibling", eventTypes: ["text.received"] })));
  await h.run();
  expect(h.subscriptions.update).toHaveBeenLastCalledWith("one", {
    expectedRevision: 1,
    eventTypes: EVENTS.filter((event) => event !== "text.received").sort(),
  });
});

it("rejects context ambiguity introduced during a retry", async () => {
  const h = harness([row({ eventTypes: ["message.received"] })]);
  h.race(() =>
    h.rows.push(
      row({
        id: "sibling",
        eventTypes: ["text.received"],
        contextConfig: { email: { mode: "count", count: 3 } },
      }),
    ),
  );
  await expect(h.run()).rejects.toThrow("context");
  expect(h.subscriptions.update).toHaveBeenCalledTimes(1);
});

it("does not resurrect deleted receivers", async () => {
  const h = harness([row({ id: "deleted", status: "deleted" as WebhookSubscription["status"] })]);
  await h.run();
  expect(h.subscriptions.create).toHaveBeenCalledTimes(1);
  expect(h.subscriptions.update).not.toHaveBeenCalled();
});

it.each([
  "Too many active webhook subscriptions",
  { detail: "Maximum 10 subscriptions reached" },
  { code: "subscription_limit_reached" },
])("capacity conflict is not a CAS retry: %j", async (detail) => {
  const previous = row({ id: "previous", url: "https://old.example/webhook" });
  const h = harness([previous]);
  h.subscriptions.create.mockRejectedValue(
    Object.assign(new Error("capacity"), { statusCode: 409, detail }),
  );
  await expect(h.run()).rejects.toThrow("capacity reached");
  expect(h.subscriptions.create).toHaveBeenCalledTimes(1);
  expect(h.subscriptions.update).not.toHaveBeenCalled();
  expect(h.subscriptions.delete).not.toHaveBeenCalled();
  expect(previous.url).toBe("https://old.example/webhook");
});

it("does not claim a different host or copy its context", async () => {
  const previous = row({
    id: "previous",
    url: "https://old.example/webhook",
    contextConfig: { email: { mode: "count", count: 3 } },
  });
  const h = harness([previous]);
  await h.run();
  expect(h.subscriptions.update).not.toHaveBeenCalled();
  expect(h.subscriptions.create).toHaveBeenCalledWith({
    agentIdentityId: "agent",
    url: URL,
    eventTypes: [...EVENTS].sort(),
  });
  expect(previous.url).toBe("https://old.example/webhook");
});
