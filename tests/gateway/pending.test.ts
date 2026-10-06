// Pending replies: consuming the next inbound as an escalation answer,
// timeout resolution, supersession, and pending-state reporting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingReplies } from "../../src/gateway/pending.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPendingReplies", () => {
  it("resolves the awaited value when a reply is consumed", async () => {
    const pending = createPendingReplies();
    const answer = pending.await("ck", 10_000);

    expect(pending.tryConsume("ck", "allow")).toBe(true);
    await expect(answer).resolves.toBe("allow");
  });

  it("reports tryConsume false when no one is waiting", () => {
    const pending = createPendingReplies();
    expect(pending.tryConsume("ck", "nobody home")).toBe(false);
  });

  it("resolves to undefined once the timeout elapses", async () => {
    const pending = createPendingReplies();
    const answer = pending.await("ck", 5_000);

    vi.advanceTimersByTime(5_000);
    await expect(answer).resolves.toBeUndefined();
  });

  it("does not let a second waiter steal an active permission answer", async () => {
    const pending = createPendingReplies();
    const first = pending.await("ck", 10_000);
    await expect(pending.await("ck", 10_000)).resolves.toBeUndefined();
    expect(pending.tryConsume("ck", "allow")).toBe(true);
    await expect(first).resolves.toBe("allow");
  });

  it("serializes prompts and leaves fresh instructions and stop commands unconsumed", async () => {
    const pending = createPendingReplies();
    const send = vi.fn(async () => {});
    const first = pending.ask("ck", 10000, undefined, send);
    const second = pending.ask("ck", 10000, undefined, send);
    expect(send).toHaveBeenCalledTimes(1);
    for (const text of [
      "/stop",
      "/new",
      "Please update the README",
      "yes, and delete every other file",
    ])
      expect(pending.tryConsume("ck", text)).toBe(false);
    expect(pending.tryConsume("ck", "allow")).toBe(true);
    await expect(first).resolves.toBe("allow");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(pending.tryConsume("ck", "reject")).toBe(true);
    await expect(second).resolves.toBe("reject");
  });

  it("cancels queued prompts and cleans up a failed send without clearing a newer owner", async () => {
    const pending = createPendingReplies();
    const first = pending.ask("ck", 10000, undefined, async () => {});
    const send = vi.fn(async () => {});
    const queued = pending.ask("ck", 10000, undefined, send);
    pending.cancel("ck");
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await expect(
      pending.ask("ck", 10000, undefined, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(pending.pending("ck")).toBe(false);
    const newer = pending.await("ck", 10000);
    expect(pending.tryConsume("ck", "allow")).toBe(true);
    await expect(newer).resolves.toBe("allow");
  });

  it("reflects whether a chatKey is currently waiting", async () => {
    const pending = createPendingReplies();
    expect(pending.pending("ck")).toBe(false);

    const answer = pending.await("ck", 10_000);
    expect(pending.pending("ck")).toBe(true);

    pending.tryConsume("ck", "reject");
    await answer;
    expect(pending.pending("ck")).toBe(false);
  });
});

it("only consumes the prompted sender, with case-insensitive email authors", async () => {
  const pending = createPendingReplies();
  const answer = pending.await("group", 10_000, {
    sender: "Sponsor@Example.com",
    channel: "email",
  });
  expect(
    pending.tryConsume("group", "allow", { sender: "other@example.com", channel: "email" }),
  ).toBe(false);
  expect(
    pending.tryConsume("group", "allow", { sender: "sponsor@example.com", channel: "sms" }),
  ).toBe(false);
  expect(pending.pending("group")).toBe(true);
  expect(
    pending.tryConsume("group", "allow", { sender: "sponsor@example.com", channel: "email" }),
  ).toBe(true);
  await expect(answer).resolves.toBe("allow");
});
