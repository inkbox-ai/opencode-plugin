// Dedup guards: request-id claim/commit/rollback semantics and the
// once-per-TTL notification guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifyOnce, createRequestDedup } from "../../src/gateway/dedup.js";

const TTL_MS = 300_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestDedup", () => {
  it("rejects a second begin while the id is in-flight", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin("req-1")).toBe(true);
    expect(dedup.begin("req-1")).toBe(false);
  });

  it("allows retry after rollback of an in-flight id", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin("req-1")).toBe(true);
    dedup.rollback("req-1");
    expect(dedup.begin("req-1")).toBe(true);
  });

  it("blocks a committed id until the TTL expires, then allows it", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin("req-1")).toBe(true);
    dedup.commit("req-1");
    expect(dedup.begin("req-1")).toBe(false);

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(dedup.begin("req-1")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(dedup.begin("req-1")).toBe(true);
  });

  it("does not unblock a committed id on rollback", () => {
    const dedup = createRequestDedup();
    dedup.begin("req-1");
    dedup.commit("req-1");
    dedup.rollback("req-1");
    expect(dedup.begin("req-1")).toBe(false);
  });

  it("evicts the oldest committed id once maxEntries is exceeded", () => {
    const dedup = createRequestDedup({ maxEntries: 2 });
    for (const id of ["a", "b", "c"]) {
      dedup.begin(id);
      dedup.commit(id);
      vi.advanceTimersByTime(1);
    }
    // "a" was evicted to make room for "c"; "b" and "c" are still recent.
    expect(dedup.begin("a")).toBe(true);
    expect(dedup.begin("b")).toBe(false);
    expect(dedup.begin("c")).toBe(false);
  });

  it("holds an in-flight id well past the committed TTL so a slow handler is not double-processed", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin("req-1")).toBe(true);
    // Past the committed TTL, a still-in-flight claim must remain held.
    vi.advanceTimersByTime(TTL_MS);
    expect(dedup.begin("req-1")).toBe(false);
  });

  it("eventually expires a stale in-flight id so a crashed handler cannot block forever", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin("req-1")).toBe(true);
    // The in-flight backstop is far larger than the committed TTL.
    vi.advanceTimersByTime(3_600_000);
    expect(dedup.begin("req-1")).toBe(true);
  });

  it("passes through undefined and empty ids without tracking them", () => {
    const dedup = createRequestDedup();
    expect(dedup.begin(undefined)).toBe(true);
    expect(dedup.begin(undefined)).toBe(true);
    expect(dedup.begin("")).toBe(true);
    expect(dedup.begin("")).toBe(true);
    expect(() => dedup.commit(undefined)).not.toThrow();
    expect(() => dedup.rollback("")).not.toThrow();
    expect(dedup.begin("")).toBe(true);
  });

  it("honors a custom ttlMs", () => {
    const dedup = createRequestDedup({ ttlMs: 1_000 });
    dedup.begin("req-1");
    dedup.commit("req-1");
    expect(dedup.begin("req-1")).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(dedup.begin("req-1")).toBe(true);
  });
});

describe("createNotifyOnce", () => {
  it("notifies once per key, then again after the TTL", () => {
    const guard = createNotifyOnce();
    expect(guard.shouldNotify("text:msg-1")).toBe(true);
    expect(guard.shouldNotify("text:msg-1")).toBe(false);

    vi.advanceTimersByTime(TTL_MS - 1);
    expect(guard.shouldNotify("text:msg-1")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(guard.shouldNotify("text:msg-1")).toBe(true);
  });

  it("tracks keys independently", () => {
    const guard = createNotifyOnce();
    expect(guard.shouldNotify("imessage:msg-1")).toBe(true);
    expect(guard.shouldNotify("imessage_reaction:msg-1")).toBe(true);
    expect(guard.shouldNotify("imessage:msg-1")).toBe(false);
  });

  it("always notifies for undefined or empty keys", () => {
    const guard = createNotifyOnce();
    expect(guard.shouldNotify(undefined)).toBe(true);
    expect(guard.shouldNotify(undefined)).toBe(true);
    expect(guard.shouldNotify("")).toBe(true);
    expect(guard.shouldNotify("")).toBe(true);
  });

  it("honors a custom ttlMs", () => {
    const guard = createNotifyOnce({ ttlMs: 5_000 });
    expect(guard.shouldNotify("text:msg-1")).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(guard.shouldNotify("text:msg-1")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(guard.shouldNotify("text:msg-1")).toBe(true);
  });
});
