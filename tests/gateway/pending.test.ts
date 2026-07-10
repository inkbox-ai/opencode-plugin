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

    expect(pending.tryConsume("ck", "the answer")).toBe(true);
    await expect(answer).resolves.toBe("the answer");
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

  it("supersedes an earlier wait for the same chatKey", async () => {
    const pending = createPendingReplies();
    const first = pending.await("ck", 10_000);
    const second = pending.await("ck", 10_000);

    await expect(first).resolves.toBeUndefined();

    expect(pending.tryConsume("ck", "for the second")).toBe(true);
    await expect(second).resolves.toBe("for the second");
  });

  it("reflects whether a chatKey is currently waiting", async () => {
    const pending = createPendingReplies();
    expect(pending.pending("ck")).toBe(false);

    const answer = pending.await("ck", 10_000);
    expect(pending.pending("ck")).toBe(true);

    pending.tryConsume("ck", "done");
    await answer;
    expect(pending.pending("ck")).toBe(false);
  });
});
