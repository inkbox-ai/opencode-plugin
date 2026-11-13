import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { afterEach, expect, it } from "vitest";
import { createBurstBuffer } from "../../src/gateway/burst.js";
import { DeliveryWork } from "../../src/gateway/delivery-work.js";
import { saveHostedCall } from "../../src/gateway/hosted-call-registry.js";
import { createStateStore, type DurableTurn } from "../../src/gateway/state.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.INKBOX_OPENCODE_HOME;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("retains every source in a delayed merged burst before native admission", async () => {
  const { work, store } = setup();
  const buffer = createBurstBuffer({
    windowMs: 60_000,
    retain: () => work.capture(),
    deliver: async () => {
      work.state.saveTurn(turn("merged"));
    },
  });
  for (const id of ["first", "second"]) {
    await work.dispatch(id, async () => {
      buffer.add({
        channel: "sms",
        chatKey: "contact",
        from: "+15550000001",
        text: id,
        mediaPaths: [],
      });
      return true;
    });
    expect(work.status(id)).toBe("pending");
  }
  expect(new DeliveryWork(store).status("first")).toBe("uncertain");
  buffer.flushAll();
  await new Promise((resolve) => setImmediate(resolve));
  expect(work.status("first")).toBe("pending");
  store.updateTurn("merged", { state: "delivered" });
  expect(work.status("first")).toBe("completed");
  expect(work.status("second")).toBe("completed");
});
it("waits for the canonical post-call job before it creates a turn", async () => {
  const { work, store } = setup();
  process.env.INKBOX_OPENCODE_HOME = join(store.filePath, "..");
  const ref = { identityId: "identity", callId: "call" };
  const call = {
    ...ref,
    eventId: "event",
    event: {
      id: "event",
      data: { call: { id: "call", mode: "hosted_agent" } },
    } as unknown as CallEndedWebhookPayload,
  };
  await work.dispatch(
    "event",
    async () => {
      saveHostedCall({ ...call, state: "queued" });
      return true;
    },
    ref,
  );
  expect(work.status("event")).toBe("pending");
  saveHostedCall({ ...call, state: "completed" });
  expect(work.status("event")).toBe("completed");
});
const setup = () => {
  const path = mkdtempSync(join(tmpdir(), "inkbox-delivery-work-"));
  roots.push(path);
  const store = createStateStore(path);
  return { store, work: new DeliveryWork(store) };
};
const turn = (id: string): DurableTurn => ({
  id,
  messageID: id,
  chatKey: id,
  kind: "normal",
  text: "",
  deliver: true,
  state: "queued",
  createdAt: 1,
  updatedAt: 1,
});
it("retains exact turn ownership through routing, reopen and completion", async () => {
  const { store, work } = setup();
  await work.dispatch("first", async () => {
    work.state.saveTurn(turn("one"));
    return true;
  });
  await work.dispatch("second", async () => {
    work.state.saveTurn(turn("two"));
    return true;
  });
  expect(work.status("first")).toBe("pending");
  store.updateTurn("one", { state: "delivered" });
  expect(new DeliveryWork(store).status("first")).toBe("completed");
  const snapshot = store.read();
  delete snapshot.turns.one;
  store.update({ turns: snapshot.turns });
  expect(new DeliveryWork(store).status("first")).toBe("completed");
  expect(work.status("second")).toBe("pending");
  let repeated = false;
  await work.dispatch("first", async () => {
    repeated = true;
    return true;
  });
  expect(repeated).toBe(false);
  store.updateTurn("two", { state: "failed", uncertainStage: "delivery" });
  expect(work.status("second")).toBe("uncertain");
  expect(work.activity()).toEqual({ pending: 0, uncertain: 1 });
});
it("does not report an interrupted dispatch completed", async () => {
  const { store, work } = setup();
  await expect(
    work.dispatch("failed", async () => {
      work.state.saveTurn(turn("one"));
      throw new Error("synthetic");
    }),
  ).rejects.toThrow();
  expect(new DeliveryWork(store).status("failed")).toBe("uncertain");
  store.update({ deliveryWork: { lost: { turns: [], routed: false } } });
  expect(work.status("lost")).toBe("uncertain");
});
it("keeps concurrent and merged turn references independent", async () => {
  const { work, store } = setup();
  await Promise.all([
    work.dispatch("first", async () => {
      await Promise.resolve();
      work.state.saveTurn(turn("one"));
      return true;
    }),
    work.dispatch("second", async () => {
      work.state.saveTurn(turn("two"));
      return true;
    }),
  ]);
  await work.dispatch("merged", async () => {
    work.state.updateTurn("one", { sourceIds: ["one", "merged"] });
    return true;
  });
  store.updateTurn("two", { state: "delivered" });
  expect(work.status("first")).toBe("pending");
  expect(work.status("second")).toBe("completed");
  expect(work.status("merged")).toBe("pending");
  store.updateTurn("one", { state: "delivered" });
  expect(work.status("merged")).toBe("completed");
});
