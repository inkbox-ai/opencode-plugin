import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promoteAfterSend, recordBeforeSend } from "../../src/a2a-delegations.js";
import {
  clearA2AProgressDrain,
  listA2AProgressDrains,
  renewA2AProgressDrain,
  requestA2AProgressDrain,
  waitForA2AProgressDrain,
} from "../../src/a2a-progress.js";
import { a2aAcknowledgementText, createA2AHandler } from "../../src/gateway/a2a.js";
import { createStateStore } from "../../src/gateway/state.js";

function event() {
  return {
    provider: "inkbox",
    verified: true,
    eventType: "a2a.task.created",
    body: {
      id: "evt-1",
      data: {
        task_id: "task-1",
        context_id: "context-1",
        state: "submitted",
        message_id: "message-1",
        caller: {
          identity_id: "caller-1",
          organization_id: "org-1",
          handle: "caller",
        },
        parts: [{ text: "Investigate." }],
      },
    },
    headers: {},
  };
}

function taskSnapshot(overrides: Record<string, any> = {}) {
  const messages = Array.isArray(overrides.messages) ? overrides.messages : [];
  const hasCurrentCaller = messages.some((message: any) => {
    const role = String(message?.role ?? "").toLowerCase();
    return (
      (role === "caller" || role === "role_caller") &&
      String(message?.messageId ?? message?.message_id ?? "") === "message-1"
    );
  });
  return {
    id: "task-1",
    contextId: "context-1",
    state: "submitted",
    caller: { identityId: "caller-1", organizationId: "org-1", handle: "caller" },
    ...overrides,
    messages: hasCurrentCaller
      ? messages
      : [
          {
            role: "caller",
            messageId: "message-1",
            parts: [{ text: "Investigate." }],
          },
          ...messages,
        ],
  };
}

function abortableA2ARun(result = "[SILENT]") {
  const pending = new Set<(value: string) => void>();
  const runA2A = vi.fn(
    (_chatKey: string, _prompt: string, _context?: any) =>
      new Promise<string>((resolve) => pending.add(resolve)),
  );
  const abortA2A = vi.fn(async () => {
    for (const resolve of pending) resolve(result);
    pending.clear();
    return true;
  });
  return { runA2A, abortA2A };
}

describe("createA2AHandler", () => {
  beforeEach(() => {
    process.env.INKBOX_OPENCODE_HOME = `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-gateway-${crypto.randomUUID()}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the exact configured cadence in the immediate acknowledgement", async () => {
    const a2aReply = vi.fn(async () => ({ state: "working" }));
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot()),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(async () => "[SILENT]") } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 60 } } as any,
    });

    await handler.handle(event());

    expect(a2aReply).toHaveBeenCalledWith("task-1", {
      intent: "progress",
      text: "Task task-1 received. Work is queued and starting. Expect progress updates about every 1 minute.",
    });
    expect((state.read().a2aProgress as any)["task-1"].acknowledgementDelivered).toBe(true);
    await handler.close();
  });

  it("formats the three-minute default and disabled acknowledgement", () => {
    expect(a2aAcknowledgementText("task-1", 180)).toBe(
      "Task task-1 received. Work is queued and starting. Expect progress updates about every 3 minutes.",
    );
    expect(a2aAcknowledgementText("task-1", 0)).toBe(
      "Task task-1 received. Work is queued and starting. Periodic progress updates are disabled.",
    );
  });

  it("recovers a lost acknowledgement response from worker-role history", async () => {
    const messages: any[] = [];
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      messages.push({ role: "agent", parts: [{ text: payload.text }] });
      throw new Error("response lost");
    });
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(async () => "[SILENT]") } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    await vi.waitFor(() => expect(a2aReply).toHaveBeenCalledTimes(1));
    await handler.close();
  });

  it("delays lost-response reconciliation so eventually consistent history cannot duplicate ack", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    let committedText = "";
    let visible = false;
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      committedText = payload.text;
      throw new Error("response lost");
    });
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () =>
            taskSnapshot({
              messages: visible ? [{ role: "agent", parts: [{ text: committedText }] }] : [],
            }),
          ),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(async () => "[SILENT]") } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    expect(a2aReply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(a2aReply).toHaveBeenCalledTimes(1);
    visible = true;
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(a2aReply).toHaveBeenCalledTimes(1));
    await handler.close();
  });

  it("does not trust a caller message that spoofs the acknowledgement", async () => {
    const receipt = a2aAcknowledgementText("task-1", 180);
    const a2aReply = vi.fn(async () => ({ state: "working" }));
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () =>
            taskSnapshot({
              messages: [{ role: "caller", messageId: "message-1", parts: [{ text: receipt }] }],
            }),
          ),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(async () => "[SILENT]") } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());

    expect(a2aReply).toHaveBeenCalledWith("task-1", {
      intent: "progress",
      text: receipt,
    });
    await handler.close();
  });

  it("sends ordered periodic updates without resetting cadence on follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const messages: any[] = [];
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      messages.push({ role: "agent", parts: [{ text: payload.text }] });
      return { state: "working" };
    });
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const summarizeA2AProgress = vi
      .fn()
      .mockResolvedValueOnce("I'm reviewing the requested records.")
      .mockResolvedValueOnce("I'm checking the requested data.");
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(async () => "[SILENT]"),
        summarizeA2AProgress,
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 60 } } as any,
    });

    await handler.handle(event());
    const startedAt = (state.read().a2aProgress as any)["task-1"].startedAt;
    await vi.advanceTimersByTimeAsync(30_000);
    const followUp = event();
    followUp.eventType = "a2a.task.message";
    followUp.body.id = "evt-2";
    followUp.body.data.message_id = "message-2";
    followUp.body.data.parts = [{ text: "Continue." }];
    await handler.handle(followUp);
    expect((state.read().a2aProgress as any)["task-1"].startedAt).toBe(startedAt);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(summarizeA2AProgress).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(summarizeA2AProgress).toHaveBeenCalledTimes(2));

    expect(a2aReply.mock.calls.map((call) => call[1].text)).toEqual([
      "Task task-1 received. Work is queued and starting. Expect progress updates about every 1 minute.",
      "I'm reviewing the requested records. (60s elapsed)",
      "I'm checking the requested data. (120s elapsed)",
    ]);
    await handler.close();
  });

  it("drains an in-flight summary before cancellation without sending it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    let release = (_value: string) => {};
    const summary = new Promise<string>((resolve) => {
      release = resolve;
    });
    const messages: any[] = [];
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      messages.push({ role: "agent", parts: [{ text: payload.text }] });
      return { state: "working" };
    });
    const sessions = abortableA2ARun();
    const { abortA2A } = sessions;
    const summarizeA2AProgress = vi.fn(() => summary);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { ...sessions, summarizeA2AProgress } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 60 } } as any,
    });

    await handler.handle(event());
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(summarizeA2AProgress).toHaveBeenCalledOnce());
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    const cancellation = handler.handle(canceled);
    release("I'm validating the work.");
    await cancellation;

    expect(a2aReply).toHaveBeenCalledTimes(1);
    expect(abortA2A).toHaveBeenCalledOnce();
    await handler.close();
  });

  it("acknowledges a cross-process terminal drain even when periodic updates are disabled", async () => {
    const messages: any[] = [];
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
            return { state: "working" };
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 0 } } as any,
    });

    await handler.handle(event());
    await vi.waitFor(() => expect(sessions.runA2A).toHaveBeenCalledOnce());
    const token = requestA2AProgressDrain("task-1");
    await expect(waitForA2AProgressDrain("task-1", token, 2_000)).resolves.toBeUndefined();

    clearA2AProgressDrain("task-1");
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    await handler.handle(canceled);
    await handler.close();
  });

  it("recovers an orphaned cross-process drain after authoritative nonterminal state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const messages: any[] = [];
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
            return { state: "working" };
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 0 } } as any,
    });

    await handler.handle(event());
    const token = requestA2AProgressDrain("task-1");
    const acknowledged = waitForA2AProgressDrain("task-1", token, 1_000);
    await vi.advanceTimersByTimeAsync(50);
    await acknowledged;
    await vi.advanceTimersByTimeAsync(6_100);

    expect(listA2AProgressDrains("task-1")).toEqual([]);
    await handler.close();
  });

  it("keeps a drain whose heartbeat renews during authoritative recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const messages: any[] = [];
    const a2aTask = vi.fn(async () => taskSnapshot({ messages }));
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask,
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
            return { state: "working" };
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 0 } } as any,
    });

    await handler.handle(event());
    const token = requestA2AProgressDrain("task-1");
    const acknowledged = waitForA2AProgressDrain("task-1", token, 1_000);
    await vi.advanceTimersByTimeAsync(50);
    await acknowledged;

    let releaseLookup = (_task: any) => {};
    const blockedLookup = new Promise<any>((resolve) => {
      releaseLookup = resolve;
    });
    const callsBeforeRecovery = a2aTask.mock.calls.length;
    a2aTask.mockImplementationOnce(() => blockedLookup);
    await vi.advanceTimersByTimeAsync(4_950);
    expect(a2aTask).toHaveBeenCalledTimes(callsBeforeRecovery + 1);

    renewA2AProgressDrain("task-1", token);
    releaseLookup({ state: "submitted", messages });
    await vi.advanceTimersByTimeAsync(50);

    expect(listA2AProgressDrains("task-1").map((request) => request.token)).toContain(token);
    clearA2AProgressDrain("task-1");
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    await handler.handle(canceled);
    await handler.close();
  });

  it("recovers legacy unfinished registry entries without NaN cadence", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const data = event().body.data;
    state.update({
      a2aTasks: {
        "task-1:message-1": {
          taskId: "task-1",
          contextId: "context-1",
          messageId: "message-1",
          state: "running",
          data,
          updatedAt: Date.now(),
        },
      },
    });
    const messages: any[] = [];
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot({ messages })),
      a2aReply: vi.fn(async (_taskId: string, payload: any) => {
        messages.push({ role: "agent", parts: [{ text: payload.text }] });
      }),
      iterA2ATasks: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
      })),
    };
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 60 } } as any,
    });

    await handler.catchUp();

    const progress = (state.read().a2aProgress as any)["task-1"];
    expect(Number.isFinite(progress.startedAt)).toBe(true);
    expect(Number.isFinite(progress.nextDueAt)).toBe(true);
    await handler.close();
  });

  it("retries persisted progress immediately after restart with the exact text", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const data = event().body.data;
    const now = Date.now();
    const receipt = a2aAcknowledgementText("task-1", 180);
    const pending = "I'm reviewing the exact pending work. (60s elapsed)";
    state.update({
      a2aTasks: {
        "task-1:message-1": {
          taskId: "task-1",
          contextId: "context-1",
          messageId: "message-1",
          state: "running",
          data,
          createdAt: now - 60_000,
          updatedAt: now,
        },
      },
      a2aProgress: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-1",
          startedAt: now - 60_000,
          nextDueAt: now + 120_000,
          active: true,
          acknowledgementText: receipt,
          acknowledgementDelivered: true,
          pendingText: pending,
          deliveredCount: 0,
          updatedAt: now,
        },
      },
    });
    const messages = [{ role: "agent", parts: [{ text: receipt }] }];
    const a2aReply = vi.fn(async () => ({ state: "working" }));
    const summarizeA2AProgress = vi.fn();
    const sessions = abortableA2ARun();
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot({ messages })),
      a2aReply,
      iterA2ATasks: vi.fn(() => (async function* () {})()),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: { ...sessions, summarizeA2AProgress } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.catchUp();
    await vi.waitFor(() => expect(a2aReply).toHaveBeenCalledOnce());

    expect(a2aReply).toHaveBeenCalledWith("task-1", {
      intent: "progress",
      text: pending,
    });
    expect(summarizeA2AProgress).not.toHaveBeenCalled();
    expect((state.read().a2aProgress as any)["task-1"].pendingText).toBeUndefined();
    expect((state.read().a2aProgress as any)["task-1"]).toMatchObject({
      lastDeliveredText: pending,
      deliveredCount: 1,
    });
    await handler.close();
  });

  it("reconciles a lost progress response before starting a follow-up", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const now = Date.now();
    const receipt = a2aAcknowledgementText("task-1", 180);
    const pending = "I'm checking the exact pending result. (60s elapsed)";
    state.update({
      a2aProgress: {
        "task-1": {
          taskId: "task-1",
          contextId: "context-1",
          startedAt: now - 60_000,
          nextDueAt: now + 120_000,
          active: true,
          acknowledgementText: receipt,
          acknowledgementDelivered: true,
          pendingText: pending,
          deliveredCount: 0,
          updatedAt: now,
        },
      },
    });
    const messages: any[] = [
      { role: "agent", parts: [{ text: receipt }] },
      { role: "role_agent", parts: [{ text: pending }] },
    ];
    const a2aReply = vi.fn();
    const summarizeA2AProgress = vi.fn();
    const sessions = abortableA2ARun();
    const { runA2A } = sessions;
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { ...sessions, summarizeA2AProgress } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const followUp = event();
    followUp.eventType = "a2a.task.message";
    followUp.body.id = "evt-2";
    followUp.body.data.message_id = "message-2";
    followUp.body.data.parts = [{ text: "Continue from the latest result." }];
    messages.push({
      role: "role_caller",
      messageId: "message-2",
      parts: [{ text: "Continue from the latest result." }],
    });

    await handler.handle(followUp);
    await vi.waitFor(() =>
      expect((state.read().a2aProgress as any)["task-1"].pendingText).toBeUndefined(),
    );

    expect(a2aReply).not.toHaveBeenCalled();
    expect(summarizeA2AProgress).not.toHaveBeenCalled();
    expect((state.read().a2aProgress as any)["task-1"]).toMatchObject({
      lastDeliveredText: pending,
      deliveredCount: 1,
    });
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledOnce());
    await handler.close();
  });

  it("resumes only the newest persisted caller turn when history ends in progress", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const oldData = event().body.data;
    const latestData = {
      ...oldData,
      message_id: "message-2",
      parts: [{ text: "Use the latest persisted caller request." }],
    };
    const now = Date.now();
    state.update({
      a2aTasks: {
        "task-1:message-1": {
          taskId: "task-1",
          contextId: "context-1",
          messageId: "message-1",
          state: "running",
          data: oldData,
          createdAt: now - 1,
          updatedAt: now - 1,
        },
        "task-1:message-2": {
          taskId: "task-1",
          contextId: "context-1",
          messageId: "message-2",
          state: "running",
          data: latestData,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    const receipt = a2aAcknowledgementText("task-1", 180);
    const remoteTask = {
      id: "task-1",
      contextId: "context-1",
      state: "submitted",
      caller: { identityId: "caller-1", handle: "caller" },
      messages: [
        {
          role: "caller",
          messageId: "message-1",
          parts: [{ text: "Investigate." }],
        },
        {
          role: "role_caller",
          messageId: "message-2",
          parts: [{ text: "Remote latest caller request." }],
        },
        { role: "agent", messageId: "receipt-1", parts: [{ text: receipt }] },
        {
          role: "role_agent",
          messageId: "progress-1",
          parts: [{ text: "I am reviewing the request. (180s elapsed)" }],
        },
      ],
    };
    const sessions = abortableA2ARun();
    const { runA2A } = sessions;
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => remoteTask),
      a2aReply: vi.fn(),
      iterA2ATasks: vi.fn(() =>
        (async function* () {
          yield remoteTask;
        })(),
      ),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.catchUp();
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledTimes(1));
    expect(runA2A.mock.calls[0][1]).toContain("Use the latest persisted caller request.");
    expect(runA2A.mock.calls[0][1]).not.toContain("I am reviewing the request.");
    expect((state.read().a2aTasks as any)["task-1:message-1"].state).toBe("finalized");
    expect(identity.a2aReply).not.toHaveBeenCalled();
    await handler.close();
  });

  it("uses the latest caller message for a newly discovered submitted task", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const receipt = a2aAcknowledgementText("task-new", 180);
    const remoteTask = {
      id: "task-new",
      contextId: "context-new",
      state: "submitted",
      caller: { identityId: "caller-1", handle: "caller" },
      messages: [
        {
          role: "caller",
          messageId: "message-old",
          parts: [{ text: "Use the old caller request." }],
        },
        {
          role: "role_caller",
          messageId: "message-new",
          parts: [{ text: "Use the latest caller request." }],
        },
        { role: "agent", messageId: "receipt-1", parts: [{ text: receipt }] },
        {
          role: "role_agent",
          messageId: "progress-1",
          parts: [{ text: "I am reviewing the request. (180s elapsed)" }],
        },
      ],
    };
    const sessions = abortableA2ARun();
    const { runA2A } = sessions;
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => remoteTask),
      a2aReply: vi.fn(),
      iterA2ATasks: vi.fn(() =>
        (async function* () {
          yield remoteTask;
        })(),
      ),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.catchUp();
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledTimes(1));
    expect(runA2A.mock.calls[0][1]).toContain("Use the latest caller request.");
    expect(runA2A.mock.calls[0][1]).not.toContain("Use the old caller request.");
    expect(runA2A.mock.calls[0][1]).not.toContain("I am reviewing the request.");
    expect((state.read().a2aTasks as any)["task-new:message-new"].data.parts).toEqual([
      { text: "Use the latest caller request." },
    ]);
    expect(identity.a2aReply).not.toHaveBeenCalled();
    await handler.close();
  });

  it("fences cancellation that arrives while acknowledgement state is loading", async () => {
    let release = (_task: any) => {};
    const task = new Promise<any>((resolve) => {
      release = resolve;
    });
    const a2aReply = vi.fn();
    const a2aTask = vi.fn(() => task);
    const sessions = { runA2A: vi.fn(), abortA2A: vi.fn(async () => true) };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask,
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const initial = handler.handle(event());
    await vi.waitFor(() => expect(a2aTask).toHaveBeenCalledOnce());
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    const cancellation = handler.handle(canceled);
    release(taskSnapshot());
    await Promise.all([initial, cancellation]);

    expect(a2aReply).not.toHaveBeenCalled();
    expect(sessions.runA2A).not.toHaveBeenCalled();
    await handler.close();
  });

  it("reactivates a canceled task only for one distinct authoritative caller message", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    state.update({
      a2aTasks: {
        "task-1:message-registry": {
          taskId: "task-1",
          contextId: "context-1",
          messageId: "message-registry",
          state: "running",
          data: {
            task_id: "task-1",
            context_id: "context-1",
            message_id: "message-registry",
            parts: [{ text: "This persisted generation must not run." }],
          },
          generation: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    let authoritativeTask: any = {
      id: "task-1",
      contextId: "context-1",
      state: "canceled",
      messages: [
        {
          role: "caller",
          messageId: "message-current",
          parts: [{ text: "This canceled generation must not run." }],
        },
      ],
    };
    const a2aTask = vi.fn(async () => authoritativeTask);
    const a2aReply = vi.fn(async () => ({ state: "working" }));
    const runA2A = vi.fn(async (_chatKey: string, _prompt: string) => "[SILENT]");
    const abortA2A = vi.fn(async () => true);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask,
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A, abortA2A } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    delete (canceled.body.data as any).message_id;
    await handler.handle(canceled);

    const taskMessage = (
      messageId: string,
      contextId = "context-1",
      text = "Untrusted webhook text.",
    ) => {
      const next = event();
      next.eventType = "a2a.task.message";
      next.body.id = `event-${messageId}-${contextId}`;
      next.body.data.context_id = contextId;
      next.body.data.message_id = messageId;
      next.body.data.parts = [{ text }];
      return next;
    };

    await handler.handle(taskMessage("message-registry"));
    await handler.handle(taskMessage("message-current"));
    expect(runA2A).not.toHaveBeenCalled();

    authoritativeTask = {
      id: "task-1",
      contextId: "context-1",
      state: "working",
      messages: [
        {
          role: "caller",
          messageId: "message-authoritative",
          parts: [{ text: "Trusted authoritative follow-up." }],
        },
      ],
    };
    await handler.handle(taskMessage("message-spoofed"));
    await handler.handle(taskMessage("message-authoritative", "context-wrong"));

    authoritativeTask = { ...authoritativeTask, id: "task-wrong" };
    await handler.handle(taskMessage("message-authoritative"));

    authoritativeTask = {
      ...authoritativeTask,
      id: "task-1",
      messages: [
        {
          role: "agent",
          messageId: "message-authoritative",
          parts: [{ text: "This is not caller-authored." }],
        },
      ],
    };
    await handler.handle(taskMessage("message-authoritative"));

    authoritativeTask = {
      id: "task-1",
      contextId: "context-1",
      state: "canceled",
      messages: [
        {
          role: "role_caller",
          messageId: "message-authoritative",
          parts: [{ text: "Trusted authoritative follow-up." }],
        },
      ],
    };
    await handler.handle(taskMessage("message-authoritative"));
    expect(runA2A).not.toHaveBeenCalled();

    authoritativeTask = { ...authoritativeTask, state: "submitted" };
    const genuine = taskMessage("message-authoritative", "context-1", "Spoofed body.");
    await handler.handle(genuine);
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledTimes(1));
    expect(runA2A.mock.calls[0][1]).toContain("Trusted authoritative follow-up.");
    expect(runA2A.mock.calls[0][1]).not.toContain("Spoofed body.");

    await handler.handle(genuine);
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledTimes(1));
    expect((state.read().a2aTasks as any)["task-1:message-authoritative"].generation).toBe(2);
    await handler.close();
  });

  it("rejects a stale canceled generation after restart and admits the authoritative caller once", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const canceledTask = taskSnapshot({ state: "canceled" });
    const first = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => canceledTask),
          a2aReply: vi.fn(),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(), abortA2A: vi.fn(async () => true) } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    delete (canceled.body.data as any).message_id;
    await first.handle(canceled);
    await first.close();

    const authoritativeTask = taskSnapshot({
      state: "working",
      messages: [
        {
          role: "role_caller",
          messageId: "message-2",
          parts: [{ text: "Trusted request after restart." }],
        },
      ],
    });
    const runA2A = vi.fn(async (_chatKey: string, _prompt: string) => "[SILENT]");
    const a2aReply = vi.fn(async () => ({ state: "working" }));
    const restarted = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => authoritativeTask),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A, abortA2A: vi.fn(async () => true) } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const delayed = event();
    await restarted.handle(delayed);
    expect(runA2A).not.toHaveBeenCalled();
    expect(a2aReply).not.toHaveBeenCalled();

    const followUp = event();
    followUp.eventType = "a2a.task.message";
    followUp.body.id = "evt-2";
    followUp.body.data.message_id = "message-2";
    followUp.body.data.parts = [{ text: "Spoofed webhook request." }];
    await restarted.handle(followUp);
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledOnce());
    expect(runA2A.mock.calls[0][1]).toContain("Trusted request after restart.");
    expect(runA2A.mock.calls[0][1]).not.toContain("Spoofed webhook request.");

    await restarted.handle(followUp);
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledOnce());
    await restarted.close();
  });

  it("clears the monitor when remote terminal state stops periodic progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    let taskState = "submitted";
    const messages: any[] = [];
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ state: taskState, messages })),
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        ...sessions,
        summarizeA2AProgress: vi.fn(async () => "I'm validating the work."),
      } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 1 } } as any,
    });

    await handler.handle(event());
    taskState = "completed";
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(clearIntervalSpy).toHaveBeenCalled());
    clearIntervalSpy.mockRestore();
    await handler.close();
  });

  it.each(["complete", "ask_caller", "fail"])(
    "persists an explicit %s reply fence before an ambiguous send and honors it after restart",
    async (intent) => {
      const state = createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      );
      const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
        if (payload.intent === "progress") return { state: "working" };
        throw new Error("response lost");
      });
      const runA2A = vi.fn(async (_chatKey: string, _prompt: string, context: any) => {
        await context.beforeReplyIntent();
        expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true);
        await a2aReply("task-1", { intent, text: "Explicit outcome." });
        context.replyIntentCommitted = true;
        return "[SILENT]";
      });
      const identity = {
        id: "identity-1",
        a2aTask: vi.fn(async () => taskSnapshot()),
        a2aReply,
        iterA2ATasks: vi.fn(() => (async function* () {})()),
      };
      const handler = createA2AHandler({
        inkbox: {
          getIdentity: vi.fn(async () => identity),
          getClient: vi.fn(),
        } as any,
        sessions: { runA2A, abortA2A: vi.fn(async () => true) } as any,
        state,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await handler.handle(event());
      await vi.waitFor(() =>
        expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true),
      );
      await handler.close();

      const restartedRun = vi.fn(async () => "[SILENT]");
      const restartedReply = vi.fn();
      const restarted = createA2AHandler({
        inkbox: {
          getIdentity: vi.fn(async () => ({
            ...identity,
            a2aReply: restartedReply,
          })),
          getClient: vi.fn(),
        } as any,
        sessions: {
          runA2A: restartedRun,
          abortA2A: vi.fn(async () => true),
        } as any,
        state,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      await restarted.catchUp();
      await restarted.handle(event());

      expect(restartedRun).not.toHaveBeenCalled();
      expect(restartedReply).not.toHaveBeenCalled();
      expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true);
      await restarted.close();
    },
  );

  it("fences an ambiguous implicit completion but allows a genuine caller follow-up", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      if (payload.intent === "progress") return { state: "working" };
      throw new Error("response lost");
    });
    const authoritativeMessages: any[] = [];
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot({ messages: authoritativeMessages })),
      a2aReply,
      iterA2ATasks: vi.fn(() => (async function* () {})()),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(async () => "Plain final answer."),
        abortA2A: vi.fn(async () => true),
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    await vi.waitFor(() =>
      expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true),
    );
    await handler.close();

    const restartedRun = vi.fn(async () => "[SILENT]");
    const restartedReply = vi.fn();
    const restarted = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          ...identity,
          a2aReply: restartedReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: restartedRun,
        abortA2A: vi.fn(async () => true),
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await restarted.catchUp();
    await restarted.handle(event());
    expect(restartedRun).not.toHaveBeenCalled();
    expect(restartedReply).not.toHaveBeenCalled();

    const followUp = event();
    followUp.eventType = "a2a.task.message";
    followUp.body.id = "evt-2";
    followUp.body.data.message_id = "message-2";
    followUp.body.data.parts = [{ text: "Genuine follow-up." }];
    authoritativeMessages.push({
      role: "caller",
      messageId: "message-2",
      parts: [{ text: "Genuine follow-up." }],
    });
    await restarted.handle(followUp);
    await vi.waitFor(() => expect(restartedRun).toHaveBeenCalledOnce());
    expect((state.read().a2aTasks as any)["task-1:message-2"].replyIntentFenced).not.toBe(true);
    await restarted.close();
  });

  it("keeps a durable reply fence while the stale drain monitor runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      if (payload.intent === "progress") return { state: "working" };
      throw new Error("response lost");
    });
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot()),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(async () => "Plain final answer."),
        abortA2A: vi.fn(async () => true),
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 1 } } as any,
    });

    await handler.handle(event());
    await vi.waitFor(() =>
      expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(7_000);

    expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true);
    expect(a2aReply).toHaveBeenCalledTimes(2);
    expect(listA2AProgressDrains("task-1")).toHaveLength(1);
    clearA2AProgressDrain("task-1");
    await handler.close();
  });

  it("acknowledges a fenced drain requested by a separate tool host", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const messages: any[] = [];
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      messages.push({ role: "agent", parts: [{ text: payload.text }] });
      return { state: "working" };
    });
    const sessions = abortableA2ARun();
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 0 } } as any,
    });
    await handler.handle(event());

    vi.resetModules();
    const separateProgress = await import("../../src/a2a-progress.js");
    const separateContext = await import("../../src/a2a-context.js");
    const context = {
      taskId: "task-1",
      contextId: "context-1",
      messageId: "message-1",
      replyIntentCommitted: false,
      registryKey: "task-1:message-1",
      registryFilePath: state.filePath,
    };
    separateContext.setActiveA2ATurn("separate-session", context);
    separateContext.fenceActiveA2AReplyIntent("separate-session", context);
    expect(await separateProgress.drainA2AProgress("task-1")).toBe(false);

    const token = separateProgress.requestA2AProgressDrain("task-1");
    await separateProgress.waitForA2AProgressDrain("task-1", token, 2_000);
    await a2aReply("task-1", { intent: "ask_caller", text: "Which region?" });

    expect((state.read().a2aTasks as any)["task-1:message-1"].replyIntentFenced).toBe(true);
    expect(a2aReply).toHaveBeenLastCalledWith("task-1", {
      intent: "ask_caller",
      text: "Which region?",
    });
    separateProgress.clearA2AProgressDrain("task-1", token);
    separateContext.clearActiveA2ATurn("separate-session", context);
    await handler.close();
  });

  it("keeps a newer caller turn current when the older fenced turn finalizes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const messages: any[] = [];
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      messages.push({ role: "agent", parts: [{ text: payload.text }] });
      return { state: "working" };
    });
    let releaseOld = () => {};
    let releaseNew = () => {};
    let oldFenced = () => {};
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const fenced = new Promise<void>((resolve) => {
      oldFenced = resolve;
    });
    let runCount = 0;
    const runA2A = vi.fn(async (_chatKey: string, _prompt: string, context: any) => {
      runCount += 1;
      if (runCount === 1) {
        await context.beforeReplyIntent();
        oldFenced();
        await oldGate;
        context.replyIntentCommitted = true;
      } else {
        await newGate;
      }
      return "[SILENT]";
    });
    const summarizeA2AProgress = vi.fn(async () => "I'm reviewing the follow-up.");
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot({ messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A,
        summarizeA2AProgress,
        abortA2A: vi.fn(async () => {
          releaseOld();
          releaseNew();
          return true;
        }),
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { gateway: { a2aProgressIntervalSeconds: 1 } } as any,
    });

    await handler.handle(event());
    await fenced;
    const followUp = event();
    followUp.eventType = "a2a.task.message";
    followUp.body.id = "evt-2";
    followUp.body.data.message_id = "message-2";
    followUp.body.data.parts = [{ text: "Continue with this follow-up." }];
    messages.push({
      role: "role_caller",
      messageId: "message-2",
      parts: [{ text: "Continue with this follow-up." }],
    });
    await handler.handle(followUp);
    await vi.waitFor(() => expect(runA2A).toHaveBeenCalledTimes(2));

    releaseOld();
    await vi.advanceTimersByTimeAsync(1_000);

    expect((state.read().a2aProgress as any)["task-1"].active).toBe(true);
    expect(summarizeA2AProgress).toHaveBeenCalled();
    expect(
      a2aReply.mock.calls.some(
        ([, payload]) => payload.intent === "progress" && payload.text.includes("follow-up"),
      ),
    ).toBe(true);
    releaseNew();
    await handler.close();
  });

  it("waits for a blocked terminal reply before cancellation returns", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    let releaseTerminal = () => {};
    let terminalStarted = () => {};
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const terminalCall = new Promise<void>((resolve) => {
      terminalStarted = resolve;
    });
    const a2aReply = vi.fn(async (_taskId: string, payload: any) => {
      if (payload.intent === "complete") {
        terminalStarted();
        await terminalGate;
      }
      return { state: "working" };
    });
    const abortA2A = vi.fn(async () => true);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot()),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(async () => "Final answer."),
        abortA2A,
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    await terminalCall;
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";
    let settled = false;
    const cancellation = handler.handle(canceled).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseTerminal();
    await cancellation;
    const stateAfterCancellation = JSON.stringify(state.read());
    await Promise.resolve();
    expect(JSON.stringify(state.read())).toBe(stateAfterCancellation);
    await handler.close();
  });

  it("waits for an abort-insensitive dispatch before close returns", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    let releaseDispatch = (_value: string) => {};
    let dispatchStarted = () => {};
    const dispatchGate = new Promise<string>((resolve) => {
      releaseDispatch = resolve;
    });
    const dispatchCall = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const abortA2A = vi.fn(async () => true);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => taskSnapshot()),
          a2aReply: vi.fn(async () => ({ state: "working" })),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(() => {
          dispatchStarted();
          return dispatchGate;
        }),
        abortA2A,
      } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    await dispatchCall;
    let settled = false;
    const close = handler.close().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(abortA2A).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseDispatch("Late answer.");
    await close;
    const stateAfterClose = JSON.stringify(state.read());
    await Promise.resolve();
    expect(JSON.stringify(state.read())).toBe(stateAfterClose);
  });

  it("rejects admission after close without side effects", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const getIdentity = vi.fn(async () => ({
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot()),
      a2aReply: vi.fn(),
    }));
    const runA2A = vi.fn();
    const handler = createA2AHandler({
      inkbox: { getIdentity, getClient: vi.fn() } as any,
      sessions: { runA2A, abortA2A: vi.fn(async () => true) } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.close();
    getIdentity.mockClear();
    await handler.handle(event());

    expect(getIdentity).not.toHaveBeenCalled();
    expect(runA2A).not.toHaveBeenCalled();
    expect(state.read().a2aTasks).toBeUndefined();
  });

  it("persists before ack, dedupes, and guarded-completes", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const a2aReply = vi.fn(async () => ({ id: "task-1", state: "completed" }));
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot()),
      a2aReply,
    };
    const sessions = {
      runA2A: vi.fn(async () => "Completed."),
      abortA2A: vi.fn(async () => true),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: sessions as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(await handler.handle(event())).toBe(true);
    expect((state.read().a2aTasks as any)["task-1:message-1"]).toBeDefined();
    expect(await handler.handle(event())).toBe(true);
    await vi.waitFor(() => {
      expect(a2aReply).toHaveBeenCalledWith("task-1", {
        intent: "complete",
        text: "Completed.",
      });
    });
    expect(sessions.runA2A).toHaveBeenCalledTimes(1);
    expect(sessions.runA2A).toHaveBeenCalledWith(
      "a2a:identity-1:context-1",
      expect.stringContaining(
        "When caller input is needed, use inkbox_a2a_ask_caller and wait for the caller",
      ),
      expect.objectContaining({ taskId: "task-1", contextId: "context-1" }),
    );
    expect((state.read().a2aTasks as any)["task-1:message-1"].state).toBe("finalized");
  });

  it("does not overwrite an input-required outcome with default completion", async () => {
    const a2aReply = vi.fn();
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => taskSnapshot({ state: "input_required" })),
      a2aReply,
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(async () => "Which region?"),
      } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await handler.handle(event());
    await vi.waitFor(() => {
      expect(identity.a2aTask).toHaveBeenCalledWith("task-1");
    });

    expect(a2aReply).not.toHaveBeenCalled();
  });

  it("cancels only the addressed task on its context session", async () => {
    const abortA2A = vi.fn(async () => true);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({ id: "identity-1" })),
        getClient: vi.fn(),
      } as any,
      sessions: { abortA2A } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const canceled = event();
    canceled.eventType = "a2a.task.canceled";

    await handler.handle(canceled);

    expect(abortA2A).toHaveBeenCalledWith("a2a:identity-1:context-1", "task-1");
  });

  it("injects sent-task updates into the delegating session", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    state.setSession("contact-1", "session-1");
    const key = recordBeforeSend({
      identityId: "identity-1",
      rpcUrl: "https://target.example/a2a",
      cardUrl: "https://target.example/card",
      messageId: "message-1",
      sessionId: "session-1",
    });
    promoteAfterSend(key, "context-1", "task-1");
    const runCapture = vi.fn(async () => "Handled.");
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({ id: "identity-1" })),
        getClient: vi.fn(),
      } as any,
      sessions: { runCapture } as any,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const updated = event();
    updated.eventType = "a2a.sent_task.updated";
    updated.body.data.state = "input_required";
    updated.body.data.parts = [{ text: "Which region?" }];

    await handler.handle(updated);

    expect(runCapture).toHaveBeenCalledWith("contact-1", expect.stringContaining("Which region?"));
  });

  it("does not wake the requester model for nonterminal progress", async () => {
    const runCapture = vi.fn(async () => "Handled.");
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({ id: "identity-1" })),
        getClient: vi.fn(),
      } as any,
      sessions: { runCapture } as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const updated = event();
    updated.eventType = "a2a.sent_task.updated";
    updated.body.data.state = "working";
    updated.body.data.parts = [{ text: "I'm reviewing the material. (60s elapsed)" }];

    await handler.handle(updated);

    expect(runCapture).not.toHaveBeenCalled();
  });

  it("continues startup when the A2A API is not deployed yet", async () => {
    const unavailable = Object.assign(new Error("HTTP 404: Not Found"), {
      statusCode: 404,
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const identity = {
      a2aTask: vi.fn(),
      a2aReply: vi.fn(),
      iterA2ATasks: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn(async () => {
            throw unavailable;
          }),
        }),
      })),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: {} as any,
      state: createStateStore(
        `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
      ),
      logger,
    });

    await expect(handler.catchUp()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("a2a.api_unavailable", {
      error: "Error: HTTP 404: Not Found",
    });
  });
});
