import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { imessageReadTools } from "../../src/tools/imessage-reads.js";
import type { ToolDeps } from "../../src/tools/types.js";

function makeDeps(
  identityStub: Record<string, unknown>,
  clientStub: Record<string, unknown> = {},
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => clientStub),
  };
  const config = {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    ...overrides,
  };
  const vault = { keyEnvVar: "INKBOX_VAULT_KEY", getCredentials: vi.fn() };
  return { runtime, config, vault } as unknown as ToolDeps;
}

function makeCtx() {
  return { ask: vi.fn(async () => {}), abort: new AbortController().signal } as any;
}

function makeIdentity() {
  return {
    agentHandle: "helper-bot",
    listIMessageConversations: vi.fn(async () => [
      { id: "conv-1", unreadCount: 2, assignmentStatus: "active" },
      { id: "conv-2", unreadCount: 0, assignmentStatus: "released" },
    ]),
    listIMessages: vi.fn(async () => [{ id: "msg-1", text: "hi" }]),
    listIMessageAssignments: vi.fn(async () => [
      { id: "assign-1", recipientNumber: "+15551230000" },
    ]),
    sendIMessageReaction: vi.fn(async () => ({ id: "react-1", reaction: "love" })),
    markIMessageConversationRead: vi.fn(async () => ({
      conversationId: "conv-1",
      updatedCount: 4,
    })),
  };
}

function makeClient(triage: Record<string, unknown>) {
  return {
    imessages: { getTriageNumber: vi.fn(async () => triage) },
  };
}

function findTool(tools: ReturnType<typeof imessageReadTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("imessageReadTools", () => {
  it("registers the six iMessage tools in the imessage group", () => {
    const tools = imessageReadTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_imessage_conversations",
      "inkbox_get_imessage_conversation",
      "inkbox_imessage_triage_number",
      "inkbox_list_imessage_assignments",
      "inkbox_send_imessage_reaction",
      "inkbox_mark_imessage_conversation_read",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("imessage");
      expect(tool.sensitive).toBeFalsy();
    }
  });

  it("enables conversation triage by default and keeps the rest opt-in", () => {
    const tools = imessageReadTools(makeDeps(makeIdentity()));
    const enabledByDefault = [
      "inkbox_list_imessage_conversations",
      "inkbox_get_imessage_conversation",
    ];
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(enabledByDefault.includes(tool.name));
    }
  });

  describe("inkbox_list_imessage_conversations", () => {
    it("lists conversations with default paging", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_list_imessage_conversations",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listIMessageConversations).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 2 iMessage conversation(s).");
      expect(text).toContain('"id": "conv-1"');
      expect(text).toContain('"assignmentStatus": "released"');
    });

    it("passes explicit paging through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_list_imessage_conversations",
      );
      await tool.definition.execute({ limit: 5, offset: 10 }, makeCtx());
      expect(identity.listIMessageConversations).toHaveBeenCalledWith({
        limit: 5,
        offset: 10,
      });
    });

    it("declares a schema that bounds limit to 1..200", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_list_imessage_conversations",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 200, offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ offset: -1 }).success).toBe(false);
    });
  });

  describe("inkbox_get_imessage_conversation", () => {
    it("fetches messages by conversation UUID with default paging", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_get_imessage_conversation",
      );
      const result = await tool.definition.execute({ conversationId: "conv-1" }, makeCtx());
      expect(identity.listIMessages).toHaveBeenCalledWith({
        conversationId: "conv-1",
        limit: 50,
        offset: 0,
      });
      expect(outputText(result)).toContain("Returned 1 iMessage(s) in conversation conv-1.");
    });

    it("passes explicit paging through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_get_imessage_conversation",
      );
      await tool.definition.execute({ conversationId: "conv-1", limit: 10, offset: 5 }, makeCtx());
      expect(identity.listIMessages).toHaveBeenCalledWith({
        conversationId: "conv-1",
        limit: 10,
        offset: 5,
      });
    });

    it("declares a schema that requires conversationId and bounds limit", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_get_imessage_conversation",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ conversationId: "conv-1" }).success).toBe(true);
      expect(schema.safeParse({ conversationId: "conv-1", limit: 200 }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ conversationId: 42 }).success).toBe(false);
      expect(schema.safeParse({ conversationId: "conv-1", limit: 201 }).success).toBe(false);
    });
  });

  describe("inkbox_imessage_triage_number", () => {
    it("returns the router number and the server-provided connect command", async () => {
      const client = makeClient({
        number: "+18885550100",
        connectCommand: "connect @helper-bot",
      });
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity(), client)),
        "inkbox_imessage_triage_number",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(client.imessages.getTriageNumber).toHaveBeenCalled();
      const text = outputText(result);
      expect(text).toContain('"number": "+18885550100"');
      expect(text).toContain('"connectCommand": "connect @helper-bot"');
    });

    it("pins a placeholder connect command to this identity's handle", async () => {
      const client = makeClient({
        number: "+18885550100",
        connectCommand: "connect @your-handle",
      });
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity(), client)),
        "inkbox_imessage_triage_number",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(outputText(result)).toContain('"connectCommand": "connect @helper-bot"');
    });

    it("builds the connect command when the server omits one", async () => {
      const client = makeClient({ number: "+18885550100" });
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity(), client)),
        "inkbox_imessage_triage_number",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(outputText(result)).toContain('"connectCommand": "connect @helper-bot"');
    });

    it("declares an empty argument schema", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_imessage_triage_number",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
    });
  });

  describe("inkbox_list_imessage_assignments", () => {
    it("lists active connections with default paging", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_list_imessage_assignments",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listIMessageAssignments).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 1 active iMessage connection(s).");
      expect(text).toContain('"recipientNumber": "+15551230000"');
    });

    it("passes explicit paging through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_list_imessage_assignments",
      );
      await tool.definition.execute({ limit: 3, offset: 6 }, makeCtx());
      expect(identity.listIMessageAssignments).toHaveBeenCalledWith({
        limit: 3,
        offset: 6,
      });
    });

    it("declares a schema that bounds limit to 1..200", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_list_imessage_assignments",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 200, offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
    });
  });

  describe("inkbox_send_imessage_reaction", () => {
    it("sends a tapback with the default part index and summarizes it", async () => {
      const identity = makeIdentity();
      const tool = findTool(imessageReadTools(makeDeps(identity)), "inkbox_send_imessage_reaction");
      const result = await tool.definition.execute(
        { messageId: "msg-1", reaction: "love" },
        makeCtx(),
      );
      expect(identity.sendIMessageReaction).toHaveBeenCalledWith({
        messageId: "msg-1",
        reaction: "love",
        partIndex: 0,
      });
      expect(result).toMatchObject({ title: expect.stringContaining("tapback") });
      expect(outputText(result)).toContain(
        "Sent love tapback to message msg-1 (reaction id=react-1).",
      );
    });

    it("passes an explicit part index through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(imessageReadTools(makeDeps(identity)), "inkbox_send_imessage_reaction");
      await tool.definition.execute(
        { messageId: "msg-1", reaction: "laugh", partIndex: 2 },
        makeCtx(),
      );
      expect(identity.sendIMessageReaction).toHaveBeenCalledWith({
        messageId: "msg-1",
        reaction: "laugh",
        partIndex: 2,
      });
    });

    it("declares a schema that requires messageId and a known tapback kind", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_send_imessage_reaction",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ messageId: "msg-1", reaction: "like" }).success).toBe(true);
      expect(
        schema.safeParse({ messageId: "msg-1", reaction: "question", partIndex: 1 }).success,
      ).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ messageId: "msg-1", reaction: "wave" }).success).toBe(false);
      expect(
        schema.safeParse({ messageId: "msg-1", reaction: "like", partIndex: -1 }).success,
      ).toBe(false);
    });
  });

  describe("inkbox_mark_imessage_conversation_read", () => {
    it("marks the conversation read and reports the updated count", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        imessageReadTools(makeDeps(identity)),
        "inkbox_mark_imessage_conversation_read",
      );
      const result = await tool.definition.execute({ conversationId: "conv-1" }, makeCtx());
      expect(identity.markIMessageConversationRead).toHaveBeenCalledWith("conv-1");
      expect(result).toMatchObject({ title: expect.stringContaining("4 message(s)") });
      expect(outputText(result)).toContain("Marked 4 message(s) as read in conversation conv-1.");
    });

    it("declares a schema that requires conversationId", () => {
      const tool = findTool(
        imessageReadTools(makeDeps(makeIdentity())),
        "inkbox_mark_imessage_conversation_read",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ conversationId: "conv-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ conversationId: 42 }).success).toBe(false);
    });
  });
});
