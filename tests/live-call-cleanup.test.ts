import { expect, it, vi } from "vitest";

it("retries early and asynchronous hangups and cleans each test without touching old calls", async () => {
  vi.useFakeTimers();
  let begin: () => Promise<void> = async () => {
    throw new Error("beforeEach was not registered");
  };
  let end: () => Promise<void> = async () => {
    throw new Error("afterEach was not registered");
  };
  const old = { id: "old", status: "in_progress", localPhoneNumber: "local" };
  const fresh = { id: "new", status: "queued", localPhoneNumber: "local" };
  const calls = [old];
  let attempts = 0;
  const hangup = vi.fn(async (id: string) => {
    expect(id).toBe("new");
    attempts++;
    if (attempts === 1) throw new Error("no active leg yet");
    if (attempts === 3) fresh.status = "completed";
  });
  vi.doMock("vitest", () => ({
    beforeEach: (fn: () => Promise<void>) => {
      begin = fn;
    },
    afterEach: (fn: () => Promise<void>) => {
      end = fn;
    },
  }));
  vi.doMock("./live/helpers.js", () => ({
    AUT_KEY: "synthetic",
    client: () => ({ calls: { hangup, get: async () => fresh } }),
    listCalls: async () => [...calls],
    phoneOf: async () => ({ number: "local" }),
  }));
  vi.stubEnv("VOICE_SCENARIO", "");
  try {
    await import("./live/setup.js");
    await begin();
    calls.push(fresh);
    await vi.advanceTimersByTimeAsync(4000);
    expect(hangup).toHaveBeenCalledTimes(3);
    const teardown = end();
    await vi.advanceTimersByTimeAsync(1000);
    await teardown;
    expect(old.status).toBe("in_progress");

    calls.pop();
    fresh.status = "queued";
    attempts = 0;
    vi.stubEnv("VOICE_SCENARIO", "synthetic");
    await begin();
    calls.push(fresh);
    const nextTeardown = end();
    await vi.advanceTimersByTimeAsync(3000);
    await nextTeardown;
    expect(fresh.status).toBe("completed");
    expect(hangup).toHaveBeenCalledTimes(6);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock("vitest");
    vi.doUnmock("./live/helpers.js");
    vi.resetModules();
  }
});
