import { afterEach, expect, it, vi } from "vitest";
import { subscribePermissionEvents } from "../../src/gateway/events.js";

afterEach(() => vi.useRealTimers());

function setup(events: unknown[]) {
  const bridge = { resolved: vi.fn(), handlePermission: vi.fn(async () => {}) };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const subscribe = vi.fn(async () => ({
    stream: (async function* () {
      yield* events;
    })(),
  }));
  const listener = subscribePermissionEvents(
    { event: { subscribe } } as never,
    bridge as never,
    logger,
    "/owned/project",
  );
  return { bridge, logger, subscribe, listener };
}

it("normalizes actual current native asked/replied events while preserving legacy shapes", async () => {
  const d = setup([
    {
      type: "permission.asked",
      properties: {
        id: "new",
        sessionID: "session",
        permission: "bash",
        patterns: ["pwd"],
        metadata: { ignored: true },
      },
    },
    {
      payload: {
        type: "permission.updated",
        properties: { id: "legacy", sessionID: "session", title: "Original title" },
      },
    },
    ...["requestID", "id", "permissionID"].map((key) => ({
      type: "permission.replied",
      properties: { [key]: key },
    })),
    { type: "permission.asked", properties: { id: 1, sessionID: "bad" } },
    { type: "permission.replied", properties: {} },
  ]);
  try {
    await vi.waitFor(() => expect(d.bridge.resolved).toHaveBeenCalledTimes(3));
    expect(d.bridge.handlePermission.mock.calls).toEqual([
      [{ permissionID: "new", sessionID: "session", title: "bash: pwd" }],
      [{ permissionID: "legacy", sessionID: "session", title: "Original title" }],
    ]);
    expect(d.bridge.resolved.mock.calls.flat()).toEqual(["requestID", "id", "permissionID"]);
    expect(d.subscribe).toHaveBeenCalledWith({
      query: { directory: "/owned/project" },
      signal: expect.any(AbortSignal),
    });
  } finally {
    d.listener.close();
  }
});

it("bounds native titles and isolates rejected admission without losing subsequent events", async () => {
  const d = setup([
    {
      type: "permission.asked",
      properties: {
        id: "first",
        sessionID: "session",
        permission: "bash",
        patterns: Array(20).fill("x".repeat(500)),
      },
    },
    {
      type: "permission.asked",
      properties: { id: "next", sessionID: "session", permission: "edit", patterns: ["file"] },
    },
  ]);
  d.bridge.handlePermission.mockRejectedValueOnce(new Error("synthetic admission failure"));
  try {
    await vi.waitFor(() => expect(d.bridge.handlePermission).toHaveBeenCalledTimes(2));
    expect((d.bridge.handlePermission.mock.calls[0] as any)[0].title).toHaveLength(1000);
    expect((d.bridge.handlePermission.mock.calls[0] as any)[0].title).toMatch(
      /… \[truncated\] \[12 additional patterns not shown\]$/,
    );
    expect(d.logger.warn).toHaveBeenCalledWith("events.permission_failed", expect.any(Object));
  } finally {
    d.listener.close();
  }
});

it("reconnects after stream end and closes the current request plus reconnect wake", async () => {
  vi.useFakeTimers();
  const d = setup([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(d.subscribe).toHaveBeenCalledTimes(2);
  const signal = (d.subscribe.mock.calls[1] as any)[0].signal;
  d.listener.close();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(d.subscribe).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shows omitted pattern counts even when text is short and marks truncated legacy titles", async () => {
  const d = setup([
    {
      type: "permission.asked",
      properties: {
        id: "many",
        sessionID: "session",
        permission: "edit",
        patterns: Array.from({ length: 9 }, (_, index) => `file-${index}`),
      },
    },
    {
      type: "permission.updated",
      properties: { id: "long", sessionID: "session", title: "x".repeat(1100) },
    },
  ]);
  try {
    await vi.waitFor(() => expect(d.bridge.handlePermission).toHaveBeenCalledTimes(2));
    const titles = d.bridge.handlePermission.mock.calls.map((call: any) => call[0].title);
    expect(titles[0]).toContain("[1 additional pattern not shown]");
    expect(titles[0]).not.toContain("file-8");
    expect(titles[1]).toHaveLength(1000);
    expect(titles[1]).toMatch(/… \[truncated\]$/);
  } finally {
    d.listener.close();
  }
});
