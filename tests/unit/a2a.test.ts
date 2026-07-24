import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveA2ATurn, setActiveA2ATurn } from "../../src/a2a-context.js";
import { defaultGatewayConfig } from "../../src/config.js";
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
    setActiveA2ATurn("session-1", context);
    try {
      const result = await tool.definition.execute({ text: "Which region?" }, ctx);
      expect(result).toContain("ask_caller");
    } finally {
      clearActiveA2ATurn("session-1", context);
    }

    expect(identity.a2aReply).toHaveBeenCalledWith("task-1", {
      intent: "ask_caller",
      text: "Which region?",
    });
    expect(context.replyIntentCommitted).toBe(true);
  });
});
