import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { a2aTurnContextPath, clearActiveA2ATurn, setActiveA2ATurn } from "../../src/a2a-context.js";
import {
  clearA2AProgressDrain,
  listA2AProgressDrains,
  registerA2AProgressDrain,
} from "../../src/a2a-progress.js";
import { defaultGatewayConfig } from "../../src/config.js";
import { createStateStore } from "../../src/gateway/state.js";
import { a2aTools } from "../../src/tools/a2a.js";

function makeCtx() {
  return {
    sessionID: "session-1",
    ask: vi.fn(async () => {}),
    abort: new AbortController().signal,
  } as any;
}

function makeDeps() {
  const a2a = {
    fetchCard: vi.fn(async (url: string) => ({ rpcUrl: `${url}/rpc` })),
    send: vi.fn(async () => ({
      kind: "task",
      task: { id: "task-1", contextId: "context-1" },
    })),
    getTask: vi.fn(async () => ({ id: "task-1", status: { state: "TASK_STATE_WORKING" } })),
    wait: vi.fn(async () => ({ id: "task-1", status: { state: "TASK_STATE_COMPLETED" } })),
    close: vi.fn(),
  };
  const identity = {
    id: "identity-1",
    a2aClient: vi.fn(async () => a2a),
    a2aTasks: vi.fn(async (options: unknown) => ({
      items: [{ id: "task-1", options }],
      nextCursor: "task-next",
    })),
    a2aMessages: vi.fn(async (options: unknown) => ({
      items: [{ id: "message-1", options }],
      nextCursor: "message-next",
    })),
    a2aReply: vi.fn(async (taskId: string, options: unknown) => ({
      id: taskId,
      ...(options as object),
    })),
  };
  return {
    a2a,
    identity,
    deps: {
      runtime: {
        getIdentity: vi.fn(async () => identity),
        getClient: vi.fn(async () => ({})),
      },
      config: {
        apiKey: "key",
        identity: "agent",
        vaultKeyEnvVar: "INKBOX_VAULT_KEY",
        tools: { enable: [], disable: [] },
        outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
        gateway: defaultGatewayConfig(),
      },
      vault: { keyEnvVar: "INKBOX_VAULT_KEY", getCredentials: vi.fn() },
    } as any,
  };
}

function getTool(name: string, deps: any) {
  const tool = a2aTools(deps).find((item) => item.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

describe("a2aTools", () => {
  beforeEach(() => {
    process.env.INKBOX_OPENCODE_HOME = `${process.env.TMPDIR ?? "/tmp"}/opencode-a2a-tools-${crypto.randomUUID()}`;
  });

  it("sends a task behind the outbound approval gate", async () => {
    const { a2a, deps } = makeDeps();
    const ctx = makeCtx();

    const result = await getTool("inkbox_a2a_call", deps).definition.execute(
      {
        cardUrl: "https://target.example/card",
        text: "Investigate.",
        messageId: "msg-1",
      },
      ctx,
    );

    expect(ctx.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "inkbox_a2a_call",
        patterns: ["https://target.example/card"],
      }),
    );
    expect(a2a.send).toHaveBeenCalledWith(
      { rpcUrl: "https://target.example/card/rpc" },
      expect.objectContaining({ text: "Investigate.", messageId: "msg-1" }),
    );
    expect(result).toContain('"task-1"');
    expect(a2a.close).toHaveBeenCalledTimes(1);
  });

  it("waits for a task without requesting outbound approval", async () => {
    const { a2a, deps } = makeDeps();
    const ctx = makeCtx();

    const result = await getTool("inkbox_a2a_check", deps).definition.execute(
      {
        cardUrl: "https://target.example/card",
        taskId: "task-1",
        wait: true,
      },
      ctx,
    );

    expect(ctx.ask).not.toHaveBeenCalled();
    expect(a2a.wait).toHaveBeenCalledWith({ rpcUrl: "https://target.example/card/rpc" }, "task-1");
    expect(result).toContain("TASK_STATE_COMPLETED");
  });

  it("replies to an input-required task behind approval", async () => {
    const { a2a, deps } = makeDeps();
    const ctx = makeCtx();

    await getTool("inkbox_a2a_reply", deps).definition.execute(
      {
        cardUrl: "https://target.example/card",
        taskId: "task-1",
        text: "More context.",
      },
      ctx,
    );

    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(a2a.send).toHaveBeenCalledWith(
      { rpcUrl: "https://target.example/card/rpc" },
      expect.objectContaining({ taskId: "task-1", text: "More context." }),
    );
  });

  it("lists filtered task and message history with cursors", async () => {
    const { deps, identity } = makeDeps();
    const ctx = makeCtx();
    const tasks = await getTool("inkbox_list_a2a_tasks", deps).definition.execute(
      {
        direction: "both",
        requesterHandle: "requester",
        workerHandle: "worker",
        state: "completed",
        contextId: "context-1",
        query: "summary",
        since: "2026-07-01T00:00:00Z",
        cursor: "task-cursor",
        limit: 3,
      },
      ctx,
    );
    const messages = await getTool("inkbox_list_a2a_messages", deps).definition.execute(
      {
        direction: "outbound",
        requesterHandle: "requester",
        workerHandle: "worker",
        taskId: "task-1",
        contextId: "context-1",
        role: "agent",
        query: "done",
        since: "2026-07-01T00:00:00Z",
        cursor: "message-cursor",
        limit: 4,
      },
      ctx,
    );

    expect(tasks).toContain("task-next");
    expect(messages).toContain("message-next");
    expect(identity.a2aTasks).toHaveBeenCalledWith({
      direction: "both",
      requesterHandle: "requester",
      workerHandle: "worker",
      state: "completed",
      contextId: "context-1",
      q: "summary",
      since: "2026-07-01T00:00:00Z",
      cursor: "task-cursor",
      limit: 3,
    });
    expect(identity.a2aMessages).toHaveBeenCalledWith({
      direction: "outbound",
      requesterHandle: "requester",
      workerHandle: "worker",
      taskId: "task-1",
      contextId: "context-1",
      role: "agent",
      q: "done",
      since: "2026-07-01T00:00:00Z",
      cursor: "message-cursor",
      limit: 4,
    });
  });

  it("gates inbound intents to the active A2A session", async () => {
    const { deps, identity } = makeDeps();
    const ctx = makeCtx();
    const context = {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
    };
    const tool = getTool("inkbox_a2a_ask_caller", deps);

    await expect(tool.definition.execute({ text: "Which region?" }, ctx)).rejects.toThrow(
      /only available/,
    );
    const unregister = registerA2AProgressDrain("task-1", {
      drain: vi.fn(async () => {}),
      resume: vi.fn(),
    });
    setActiveA2ATurn("session-1", context);
    try {
      const result = await tool.definition.execute({ text: "Which region?" }, ctx);
      expect(result).toContain("ask_caller");
    } finally {
      unregister();
      clearActiveA2ATurn("session-1", context);
    }

    expect(identity.a2aReply).toHaveBeenCalledWith("task-1", {
      intent: "ask_caller",
      text: "Which region?",
    });
    expect(context.replyIntentCommitted).toBe(true);
  });

  it("drains periodic progress before committing a terminal intent", async () => {
    const { deps, identity } = makeDeps();
    const ctx = makeCtx();
    const context = {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
    };
    let release = () => {};
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const unregister = registerA2AProgressDrain("task-1", {
      drain,
      resume: vi.fn(),
    });
    setActiveA2ATurn(ctx.sessionID, context);
    try {
      const completion = getTool("inkbox_a2a_complete", deps).definition.execute(
        { text: "Final answer." },
        ctx,
      );
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
      expect(identity.a2aReply).not.toHaveBeenCalled();
      release();
      await completion;
      expect(identity.a2aReply).toHaveBeenCalledWith("task-1", {
        intent: "complete",
        text: "Final answer.",
      });
    } finally {
      unregister();
      clearActiveA2ATurn(ctx.sessionID, context);
    }
  });

  it("keeps progress fenced when a terminal reply has an ambiguous failure", async () => {
    const { deps, identity } = makeDeps();
    const ctx = makeCtx();
    const order: string[] = [];
    const context = {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
      beforeReplyIntent: vi.fn(async () => {
        order.push("fenced");
      }),
    };
    identity.a2aReply.mockImplementationOnce(async () => {
      order.push("sent");
      throw new Error("temporary failure");
    });
    const resume = vi.fn();
    const unregister = registerA2AProgressDrain("task-1", {
      drain: vi.fn(async () => {}),
      resume,
    });
    setActiveA2ATurn(ctx.sessionID, context);
    try {
      await expect(
        getTool("inkbox_a2a_fail", deps).definition.execute({ reason: "Cannot continue." }, ctx),
      ).rejects.toThrow("temporary failure");
      expect(resume).not.toHaveBeenCalled();
      expect(listA2AProgressDrains("task-1")).toHaveLength(1);
      expect(context.replyIntentCommitted).toBe(false);
      expect(context.beforeReplyIntent).toHaveBeenCalledOnce();
      expect(order).toEqual(["fenced", "sent"]);
    } finally {
      unregister();
      clearA2AProgressDrain("task-1");
      clearActiveA2ATurn(ctx.sessionID, context);
    }
  });

  it("shares inbound turn authorization with the separate host process", async () => {
    const { deps, identity } = makeDeps();
    const ctx = makeCtx();
    const context = {
      taskId: "task-cross-process",
      messageId: "message-cross-process",
      contextId: "context-cross-process",
      replyIntentCommitted: false,
      registryKey: "task-cross-process:message-cross-process",
      registryFilePath: "",
    };
    const state = createStateStore();
    context.registryFilePath = state.filePath;
    state.update({
      a2aTasks: {
        [context.registryKey]: {
          taskId: context.taskId,
          messageId: context.messageId,
          state: "running",
        },
      },
    });
    const target = a2aTurnContextPath(ctx.sessionID);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(context)}\n`, { mode: 0o600 });
    const unregister = registerA2AProgressDrain("task-cross-process", {
      drain: vi.fn(async () => {}),
      resume: vi.fn(),
    });

    let result: any = "";
    try {
      result = await getTool("inkbox_a2a_ask_caller", deps).definition.execute(
        { text: "Which region?" },
        ctx,
      );
    } finally {
      unregister();
    }

    expect(result).toContain("ask_caller");
    expect(identity.a2aReply).toHaveBeenCalledWith("task-cross-process", {
      intent: "ask_caller",
      text: "Which region?",
    });
    expect(JSON.parse(fs.readFileSync(target, "utf8")).replyIntentCommitted).toBe(true);
    expect((state.read().a2aTasks as any)[context.registryKey].replyIntentFenced).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);

    clearActiveA2ATurn(ctx.sessionID, context);
    expect(context.replyIntentCommitted).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});
