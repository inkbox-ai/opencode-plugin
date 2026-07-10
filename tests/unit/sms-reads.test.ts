import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { smsReadTools } from "../../src/tools/sms-reads.js";
import type { ToolDeps } from "../../src/tools/types.js";

function makeDeps(
  identityStub: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => ({})),
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
    listTextConversations: vi.fn(async () => [
      { id: "conv-1", unreadCount: 2 },
      { id: "conv-2", unreadCount: 0 },
    ]),
    getTextConversation: vi.fn(async () => [{ id: "t1", body: "hi" }]),
    listTexts: vi.fn(async () => [{ id: "t1" }, { id: "t2" }, { id: "t3" }]),
    getText: vi.fn(async () => ({ id: "text-1", body: "Hello", mediaUrls: [] })),
    markTextRead: vi.fn(async () => ({ id: "text-1", isRead: true })),
    markTextConversationRead: vi.fn(async () => ({
      conversationId: "conv-1",
      updatedCount: 3,
    })),
  };
}

function findTool(tools: ReturnType<typeof smsReadTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("smsReadTools", () => {
  it("registers the six SMS read tools in the sms group", () => {
    const tools = smsReadTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_text_conversations",
      "inkbox_get_text_conversation",
      "inkbox_list_texts",
      "inkbox_get_text",
      "inkbox_mark_text_read",
      "inkbox_mark_text_conversation_read",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("sms");
      expect(tool.sensitive).toBeFalsy();
    }
  });

  it("enables conversation triage by default and keeps low-level tools opt-in", () => {
    const tools = smsReadTools(makeDeps(makeIdentity()));
    const enabledByDefault = ["inkbox_list_text_conversations", "inkbox_get_text_conversation"];
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(enabledByDefault.includes(tool.name));
    }
  });

  describe("inkbox_list_text_conversations", () => {
    it("lists conversations with default paging and groups included", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_list_text_conversations");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listTextConversations).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        includeGroups: true,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 2 text conversation(s).");
      expect(text).toContain('"id": "conv-1"');
    });

    it("passes explicit paging and the group filter through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_list_text_conversations");
      await tool.definition.execute({ limit: 5, offset: 10, includeGroups: false }, makeCtx());
      expect(identity.listTextConversations).toHaveBeenCalledWith({
        limit: 5,
        offset: 10,
        includeGroups: false,
      });
    });

    it("declares a schema that bounds limit to 1..200", () => {
      const tool = findTool(
        smsReadTools(makeDeps(makeIdentity())),
        "inkbox_list_text_conversations",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 200, offset: 0, includeGroups: true }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ includeGroups: "yes" }).success).toBe(false);
    });
  });

  describe("inkbox_get_text_conversation", () => {
    it("fetches messages by conversation UUID with default paging", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_get_text_conversation");
      const result = await tool.definition.execute({ conversationId: "conv-1" }, makeCtx());
      expect(identity.getTextConversation).toHaveBeenCalledWith("conv-1", {
        limit: 50,
        offset: 0,
      });
      expect(outputText(result)).toContain("Returned 1 text(s) in conversation conv-1.");
    });

    it("falls back to the legacy remote phone number key", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_get_text_conversation");
      const result = await tool.definition.execute(
        { remotePhoneNumber: "+15551230000", limit: 10, offset: 5 },
        makeCtx(),
      );
      expect(identity.getTextConversation).toHaveBeenCalledWith("+15551230000", {
        limit: 10,
        offset: 5,
      });
      expect(outputText(result)).toContain("conversation with +15551230000");
    });

    it("rejects when both conversation keys are provided", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_get_text_conversation");
      await expect(
        tool.definition.execute(
          { conversationId: "conv-1", remotePhoneNumber: "+15551230000" },
          makeCtx(),
        ),
      ).rejects.toThrow(/exactly one/);
      expect(identity.getTextConversation).not.toHaveBeenCalled();
    });

    it("rejects when neither conversation key is provided", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_get_text_conversation");
      await expect(tool.definition.execute({}, makeCtx())).rejects.toThrow(/exactly one/);
    });

    it("declares a schema that bounds limit to 1..500", () => {
      const tool = findTool(smsReadTools(makeDeps(makeIdentity())), "inkbox_get_text_conversation");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ conversationId: "conv-1", limit: 500 }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 501 }).success).toBe(false);
      expect(schema.safeParse({ conversationId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_list_texts", () => {
    it("lists texts with default paging and no read filter", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_list_texts");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listTexts).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        isRead: undefined,
      });
      expect(outputText(result)).toContain("Returned 3 text(s).");
    });

    it("passes the read-state filter through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_list_texts");
      await tool.definition.execute({ isRead: false, limit: 2 }, makeCtx());
      expect(identity.listTexts).toHaveBeenCalledWith({
        limit: 2,
        offset: 0,
        isRead: false,
      });
    });

    it("declares a schema that bounds limit and types isRead", () => {
      const tool = findTool(smsReadTools(makeDeps(makeIdentity())), "inkbox_list_texts");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 200, isRead: true }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ isRead: "no" }).success).toBe(false);
    });
  });

  describe("inkbox_get_text", () => {
    it("fetches a text by UUID and returns it as JSON", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_get_text");
      const result = await tool.definition.execute({ textId: "text-1" }, makeCtx());
      expect(identity.getText).toHaveBeenCalledWith("text-1");
      const text = outputText(result);
      expect(text).toContain('"id": "text-1"');
      expect(text).toContain('"body": "Hello"');
    });

    it("declares a schema that requires textId", () => {
      const tool = findTool(smsReadTools(makeDeps(makeIdentity())), "inkbox_get_text");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ textId: "text-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ textId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_mark_text_read", () => {
    it("marks the text read and summarizes it", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_mark_text_read");
      const result = await tool.definition.execute({ textId: "text-1" }, makeCtx());
      expect(identity.markTextRead).toHaveBeenCalledWith("text-1");
      expect(result).toMatchObject({ title: expect.stringContaining("text-1") });
      expect(outputText(result)).toContain("Marked text text-1 as read.");
    });

    it("declares a schema that requires textId", () => {
      const tool = findTool(smsReadTools(makeDeps(makeIdentity())), "inkbox_mark_text_read");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ textId: "text-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe("inkbox_mark_text_conversation_read", () => {
    it("marks a conversation read by UUID and reports the updated count", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_mark_text_conversation_read");
      const result = await tool.definition.execute({ conversationId: "conv-1" }, makeCtx());
      expect(identity.markTextConversationRead).toHaveBeenCalledWith("conv-1");
      expect(outputText(result)).toContain("Marked 3 message(s) as read in conversation conv-1.");
    });

    it("falls back to the legacy remote phone number key", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_mark_text_conversation_read");
      const result = await tool.definition.execute(
        { remotePhoneNumber: "+15551230000" },
        makeCtx(),
      );
      expect(identity.markTextConversationRead).toHaveBeenCalledWith("+15551230000");
      expect(outputText(result)).toContain("conversation with +15551230000");
    });

    it("rejects when both conversation keys are provided", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_mark_text_conversation_read");
      await expect(
        tool.definition.execute(
          { conversationId: "conv-1", remotePhoneNumber: "+15551230000" },
          makeCtx(),
        ),
      ).rejects.toThrow(/exactly one/);
      expect(identity.markTextConversationRead).not.toHaveBeenCalled();
    });

    it("rejects when neither conversation key is provided", async () => {
      const identity = makeIdentity();
      const tool = findTool(smsReadTools(makeDeps(identity)), "inkbox_mark_text_conversation_read");
      await expect(tool.definition.execute({}, makeCtx())).rejects.toThrow(/exactly one/);
    });

    it("declares a schema where both keys are optional strings", () => {
      const tool = findTool(
        smsReadTools(makeDeps(makeIdentity())),
        "inkbox_mark_text_conversation_read",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ conversationId: "conv-1" }).success).toBe(true);
      expect(schema.safeParse({ remotePhoneNumber: 555 }).success).toBe(false);
    });
  });
});
