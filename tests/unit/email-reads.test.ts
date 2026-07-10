import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { emailReadTools } from "../../src/tools/email-reads.js";
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

async function* asyncIterOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function makeIdentity(emails: Record<string, unknown>[] = []) {
  return {
    iterUnreadEmails: vi.fn(() => asyncIterOf(emails)),
    iterEmails: vi.fn(() => asyncIterOf(emails)),
    getMessage: vi.fn(async () => ({ id: "msg-1", subject: "Hello" })),
    getThread: vi.fn(async () => ({ id: "thread-1", folder: "inbox" })),
    markEmailsRead: vi.fn(async () => {}),
  };
}

function findTool(tools: ReturnType<typeof emailReadTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: Awaited<ReturnType<any>>): string {
  return typeof result === "string" ? result : result.output;
}

describe("emailReadTools", () => {
  it("registers the five email read tools in the email group", () => {
    const tools = emailReadTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_unread_emails",
      "inkbox_list_emails",
      "inkbox_get_email",
      "inkbox_get_email_thread",
      "inkbox_mark_emails_read",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("email");
      expect(tool.sensitive).toBeFalsy();
    }
  });

  it("enables the read tools by default but keeps mark-as-read opt-in", () => {
    const tools = emailReadTools(makeDeps(makeIdentity()));
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(tool.name !== "inkbox_mark_emails_read");
    }
  });

  describe("inkbox_list_unread_emails", () => {
    it("lists unread emails with a count header and JSON body", async () => {
      const identity = makeIdentity([{ id: "m1" }, { id: "m2" }]);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_unread_emails");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.iterUnreadEmails).toHaveBeenCalledTimes(1);
      const text = outputText(result);
      expect(text).toContain("Found 2 unread email(s).");
      expect(text).toContain('"id": "m1"');
    });

    it("caps results at the requested limit", async () => {
      const identity = makeIdentity([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_unread_emails");
      const result = await tool.definition.execute({ limit: 2 }, makeCtx());
      const text = outputText(result);
      expect(text).toContain("Found 2 unread email(s).");
      expect(text).not.toContain('"id": "m3"');
    });

    it("defaults the limit to 25 when omitted", async () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}` }));
      const identity = makeIdentity(many);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_unread_emails");
      const result = await tool.definition.execute({}, makeCtx());
      expect(outputText(result)).toContain("Found 25 unread email(s).");
    });

    it("declares a schema that bounds limit to 1..200", () => {
      const tool = findTool(emailReadTools(makeDeps(makeIdentity())), "inkbox_list_unread_emails");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 50 }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ limit: "ten" }).success).toBe(false);
    });
  });

  describe("inkbox_list_emails", () => {
    it("passes the direction filter through to the SDK", async () => {
      const identity = makeIdentity([{ id: "m1" }]);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_emails");
      const result = await tool.definition.execute({ direction: "inbound" }, makeCtx());
      expect(identity.iterEmails).toHaveBeenCalledWith({ direction: "inbound" });
      expect(outputText(result)).toContain("Returned 1 email(s).");
    });

    it("lists both directions when the filter is omitted", async () => {
      const identity = makeIdentity([{ id: "m1" }, { id: "m2" }]);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_emails");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.iterEmails).toHaveBeenCalledWith({ direction: undefined });
      expect(outputText(result)).toContain("Returned 2 email(s).");
    });

    it("caps results at the requested limit", async () => {
      const identity = makeIdentity([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_list_emails");
      const result = await tool.definition.execute({ limit: 1 }, makeCtx());
      expect(outputText(result)).toContain("Returned 1 email(s).");
    });

    it("declares a schema that restricts direction to inbound/outbound", () => {
      const tool = findTool(emailReadTools(makeDeps(makeIdentity())), "inkbox_list_emails");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ direction: "inbound", limit: 10 }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ direction: "sideways" }).success).toBe(false);
      expect(schema.safeParse({ limit: 500 }).success).toBe(false);
    });
  });

  describe("inkbox_get_email", () => {
    it("fetches a message by UUID and returns it as JSON", async () => {
      const identity = makeIdentity();
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_get_email");
      const result = await tool.definition.execute({ messageId: "msg-1" }, makeCtx());
      expect(identity.getMessage).toHaveBeenCalledWith("msg-1");
      const text = outputText(result);
      expect(text).toContain('"id": "msg-1"');
      expect(text).toContain('"subject": "Hello"');
    });

    it("declares a schema that requires messageId", () => {
      const tool = findTool(emailReadTools(makeDeps(makeIdentity())), "inkbox_get_email");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ messageId: "msg-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ messageId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_get_email_thread", () => {
    it("fetches a thread by UUID and returns it as JSON", async () => {
      const identity = makeIdentity();
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_get_email_thread");
      const result = await tool.definition.execute({ threadId: "thread-1" }, makeCtx());
      expect(identity.getThread).toHaveBeenCalledWith("thread-1");
      const text = outputText(result);
      expect(text).toContain('"id": "thread-1"');
      expect(text).toContain('"folder": "inbox"');
    });

    it("declares a schema that requires threadId", () => {
      const tool = findTool(emailReadTools(makeDeps(makeIdentity())), "inkbox_get_email_thread");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ threadId: "thread-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe("inkbox_mark_emails_read", () => {
    it("marks the given messages read and summarizes the count", async () => {
      const identity = makeIdentity();
      const tool = findTool(emailReadTools(makeDeps(identity)), "inkbox_mark_emails_read");
      const result = await tool.definition.execute({ messageIds: ["m1", "m2"] }, makeCtx());
      expect(identity.markEmailsRead).toHaveBeenCalledWith(["m1", "m2"]);
      expect(result).toMatchObject({ title: expect.stringContaining("2 email(s)") });
      expect(outputText(result)).toContain("Marked 2 email(s) as read.");
    });

    it("declares a schema that requires at least one message UUID", () => {
      const tool = findTool(emailReadTools(makeDeps(makeIdentity())), "inkbox_mark_emails_read");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ messageIds: ["m1"] }).success).toBe(true);
      expect(schema.safeParse({ messageIds: [] }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ messageIds: "m1" }).success).toBe(false);
    });
  });
});
