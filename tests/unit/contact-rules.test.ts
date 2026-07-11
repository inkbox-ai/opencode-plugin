import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { contactRuleTools } from "../../src/tools/contact-rules.js";
import type { ToolDeps } from "../../src/tools/types.js";

// Contact rules are keyed by the agent identity, so the SDK surface under
// test lives on the identity object itself.
function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    agentHandle: "agent",
    imessageEnabled: true,
    phoneNumber: { id: "pn-1", number: "+15550001111" },
    mailbox: { emailAddress: "agent@inkbox.dev" },
    listMailContactRules: vi.fn(async () => [
      { id: "mr-1", action: "block", matchType: "domain", matchTarget: "spam.example" },
    ]),
    listPhoneContactRules: vi.fn(async () => [
      { id: "pr-1", action: "block", matchType: "exact_number", matchTarget: "+15550001111" },
      { id: "pr-2", action: "allow", matchType: "exact_number", matchTarget: "+15550002222" },
    ]),
    ...overrides,
  };
}

function makeDeps(
  identityStub: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const imessageContactRules = {
    list: vi.fn(async () => [
      { id: "ir-1", action: "block", matchType: "exact_number", matchTarget: "+15550003333" },
    ]),
  };
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => ({ imessageContactRules })),
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

function findTool(tools: ReturnType<typeof contactRuleTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("contactRuleTools", () => {
  it("registers the three read-only rule tools, default-enabled", () => {
    const tools = contactRuleTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_mail_contact_rules",
      "inkbox_list_phone_contact_rules",
      "inkbox_list_imessage_contact_rules",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("contact-rules");
      expect(tool.defaultEnabled).toBe(true);
      expect(tool.sensitive).toBeFalsy();
    }
  });

  describe("inkbox_list_mail_contact_rules", () => {
    it("lists mail rules with default paging when no filters are given", async () => {
      const identity = makeIdentity();
      const tool = findTool(contactRuleTools(makeDeps(identity)), "inkbox_list_mail_contact_rules");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listMailContactRules).toHaveBeenCalledWith({
        action: undefined,
        matchType: undefined,
        limit: 50,
        offset: 0,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 1 mail rule(s).");
      expect(text).toContain('"id": "mr-1"');
    });

    it("passes action, matchType, limit, and offset through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(contactRuleTools(makeDeps(identity)), "inkbox_list_mail_contact_rules");
      await tool.definition.execute(
        { action: "block", matchType: "domain", limit: 10, offset: 5 },
        makeCtx(),
      );
      expect(identity.listMailContactRules).toHaveBeenCalledWith({
        action: "block",
        matchType: "domain",
        limit: 10,
        offset: 5,
      });
    });

    it("works for an identity without a mailbox (rules are identity-keyed)", async () => {
      const identity = makeIdentity({ mailbox: null });
      const tool = findTool(contactRuleTools(makeDeps(identity)), "inkbox_list_mail_contact_rules");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listMailContactRules).toHaveBeenCalled();
      expect(outputText(result)).toContain("Returned 1 mail rule(s).");
    });

    it("declares a schema bounding limit to 1..200 and restricting the enums", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_list_mail_contact_rules",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(
        schema.safeParse({ action: "allow", matchType: "exact_email", limit: 200, offset: 0 })
          .success,
      ).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ offset: -1 }).success).toBe(false);
      expect(schema.safeParse({ action: "mute" }).success).toBe(false);
      expect(schema.safeParse({ matchType: "exact_number" }).success).toBe(false);
    });
  });

  describe("inkbox_list_phone_contact_rules", () => {
    it("lists phone rules with default paging when no filters are given", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_list_phone_contact_rules",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listPhoneContactRules).toHaveBeenCalledWith({
        action: undefined,
        matchType: undefined,
        limit: 50,
        offset: 0,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 2 phone rule(s).");
      expect(text).toContain('"id": "pr-1"');
    });

    it("passes action, matchType, limit, and offset through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_list_phone_contact_rules",
      );
      await tool.definition.execute(
        { action: "allow", matchType: "exact_number", limit: 20, offset: 40 },
        makeCtx(),
      );
      expect(identity.listPhoneContactRules).toHaveBeenCalledWith({
        action: "allow",
        matchType: "exact_number",
        limit: 20,
        offset: 40,
      });
    });

    it("returns the empty list for a phoneless identity instead of failing", async () => {
      const identity = makeIdentity({
        phoneNumber: null,
        listPhoneContactRules: vi.fn(async () => []),
      });
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_list_phone_contact_rules",
      );
      const result = await tool.definition.execute({}, makeCtx());
      expect(outputText(result)).toContain("Returned 0 phone rule(s).");
    });

    it("declares a schema bounding limit to 1..200 and pinning matchType", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_list_phone_contact_rules",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(
        schema.safeParse({ action: "block", matchType: "exact_number", limit: 1, offset: 0 })
          .success,
      ).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ matchType: "domain" }).success).toBe(false);
    });
  });

  describe("inkbox_list_imessage_contact_rules", () => {
    it("lists iMessage rules via the client resource, keyed by handle", async () => {
      const deps = makeDeps(makeIdentity());
      const tool = findTool(contactRuleTools(deps), "inkbox_list_imessage_contact_rules");
      const result = await tool.definition.execute({}, makeCtx());
      const client = await (deps.runtime as { getClient(): Promise<any> }).getClient();
      expect(client.imessageContactRules.list).toHaveBeenCalledWith("agent", {
        action: undefined,
        matchType: undefined,
        limit: 50,
        offset: 0,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 1 iMessage rule(s).");
      expect(text).toContain('"id": "ir-1"');
    });

    it("declares a schema bounding limit and pinning matchType to exact_number", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_list_imessage_contact_rules",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ action: "allow", matchType: "exact_number" }).success).toBe(true);
      expect(schema.safeParse({ matchType: "domain" }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
    });
  });
});
