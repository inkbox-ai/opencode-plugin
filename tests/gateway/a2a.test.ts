import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteAfterSend, recordBeforeSend } from "../../src/a2a-delegations.js";
import { createA2AHandler } from "../../src/gateway/a2a.js";
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
    expect((state.read().a2aTasks as any)["task-1:message-1"].state).toBe("finalized");
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
});
