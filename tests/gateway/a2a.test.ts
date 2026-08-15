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
          a2aTask: vi.fn(async () => ({ state: "submitted", messages: [] })),
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
          a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
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
          a2aTask: vi.fn(async () => ({
            state: "submitted",
            messages: visible ? [{ role: "agent", parts: [{ text: committedText }] }] : [],
          })),
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
          a2aTask: vi.fn(async () => ({
            state: "submitted",
            messages: [{ role: "caller", parts: [{ text: receipt }] }],
          })),
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

    expect(a2aReply).toHaveBeenCalledWith("task-1", { intent: "progress", text: receipt });
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
          a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(async () => "[SILENT]"), summarizeA2AProgress } as any,
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
    const abortA2A = vi.fn(async () => true);
    const summarizeA2AProgress = vi.fn(() => summary);
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
          a2aReply,
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(() => new Promise(() => {})),
        summarizeA2AProgress,
        abortA2A,
      } as any,
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
    const sessions = {
      runA2A: vi.fn(() => new Promise(() => {})),
      abortA2A: vi.fn(async () => true),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
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
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
            return { state: "working" };
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(() => new Promise(() => {})),
        abortA2A: vi.fn(async () => true),
      } as any,
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
    const a2aTask = vi.fn(async () => ({ state: "submitted", messages }));
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
      sessions: {
        runA2A: vi.fn(() => new Promise(() => {})),
        abortA2A: vi.fn(async () => true),
      } as any,
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
      a2aTask: vi.fn(async () => ({ state: "submitted", messages })),
      a2aReply: vi.fn(async (_taskId: string, payload: any) => {
        messages.push({ role: "agent", parts: [{ text: payload.text }] });
      }),
      iterA2ATasks: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
      })),
    };
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(),
      } as any,
      sessions: { runA2A: vi.fn(() => new Promise(() => {})) } as any,
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
    release({ state: "submitted", messages: [] });
    await Promise.all([initial, cancellation]);

    expect(a2aReply).not.toHaveBeenCalled();
    expect(sessions.runA2A).not.toHaveBeenCalled();
    await handler.close();
  });

  it("clears the monitor when remote terminal state stops periodic progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    let taskState = "submitted";
    const messages: any[] = [];
    const handler = createA2AHandler({
      inkbox: {
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          a2aTask: vi.fn(async () => ({ state: taskState, messages })),
          a2aReply: vi.fn(async (_taskId: string, payload: any) => {
            messages.push({ role: "agent", parts: [{ text: payload.text }] });
          }),
        })),
        getClient: vi.fn(),
      } as any,
      sessions: {
        runA2A: vi.fn(() => new Promise(() => {})),
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

  it("persists before ack, dedupes, and guarded-completes", async () => {
    const state = createStateStore(
      `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-${crypto.randomUUID()}`,
    );
    const a2aReply = vi.fn(async () => ({ id: "task-1", state: "completed" }));
    const identity = {
      id: "identity-1",
      a2aTask: vi.fn(async () => ({ id: "task-1", state: "submitted" })),
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
      a2aTask: vi.fn(async () => ({ id: "task-1", state: "input_required" })),
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
