import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { contactRuleTools } from "../../src/tools/contact-rules.js";
import type { ToolDeps } from "../../src/tools/types.js";

// Contact rules are keyed by the agent identity, so the SDK surface under
// test lives on the identity object itself.
function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    phoneNumber: { id: "pn-1", number: "+15550001111" },
    mailbox: { emailAddress: "agent@inkbox.dev" },
    listMailContactRules: vi.fn(async () => [
      { id: "mr-1", action: "block", matchType: "domain", matchTarget: "spam.example" },
    ]),
    createMailContactRule: vi.fn(async () => ({
      id: "mr-2",
      action: "allow",
      matchType: "exact_email",
      matchTarget: "friend@example.com",
    })),
    updateMailContactRule: vi.fn(async () => ({ id: "mr-1", action: "allow", status: "paused" })),
    deleteMailContactRule: vi.fn(async () => undefined),
    listPhoneContactRules: vi.fn(async () => [
      { id: "pr-1", action: "block", matchType: "exact_number", matchTarget: "+15550001111" },
      { id: "pr-2", action: "allow", matchType: "exact_number", matchTarget: "+15550002222" },
    ]),
    createPhoneContactRule: vi.fn(async () => ({
      id: "pr-3",
      action: "block",
      matchType: "exact_number",
      matchTarget: "+15551234567",
    })),
    updatePhoneContactRule: vi.fn(async () => ({ id: "pr-1", action: "allow", status: "active" })),
    deletePhoneContactRule: vi.fn(async () => undefined),
    ...overrides,
  };
}

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

function findTool(tools: ReturnType<typeof contactRuleTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("contactRuleTools", () => {
  it("registers the eight contact-rule tools in the contact-rules group, all opt-in", () => {
    const tools = contactRuleTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_mail_contact_rules",
      "inkbox_create_mail_contact_rule",
      "inkbox_update_mail_contact_rule",
      "inkbox_delete_mail_contact_rule",
      "inkbox_list_phone_contact_rules",
      "inkbox_create_phone_contact_rule",
      "inkbox_update_phone_contact_rule",
      "inkbox_delete_phone_contact_rule",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("contact-rules");
      expect(tool.defaultEnabled).toBe(false);
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

  describe("inkbox_create_mail_contact_rule", () => {
    it("creates a mail rule and summarizes the new id", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_create_mail_contact_rule",
      );
      const result = await tool.definition.execute(
        { action: "allow", matchType: "exact_email", matchTarget: "friend@example.com" },
        makeCtx(),
      );
      expect(identity.createMailContactRule).toHaveBeenCalledWith({
        action: "allow",
        matchType: "exact_email",
        matchTarget: "friend@example.com",
      });
      expect(result).toMatchObject({ title: expect.stringContaining("mr-2") });
      expect(outputText(result)).toContain("Created mail contact rule id=mr-2.");
    });

    it("declares a schema requiring action, matchType, and a non-empty matchTarget", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_create_mail_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(
        schema.safeParse({ action: "block", matchType: "domain", matchTarget: "spam.example" })
          .success,
      ).toBe(true);
      expect(schema.safeParse({ action: "block", matchType: "domain" }).success).toBe(false);
      expect(
        schema.safeParse({ action: "block", matchType: "domain", matchTarget: "" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ action: "block", matchType: "exact_number", matchTarget: "x" }).success,
      ).toBe(false);
    });
  });

  describe("inkbox_update_mail_contact_rule", () => {
    it("updates action and status on a mail rule", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_update_mail_contact_rule",
      );
      const result = await tool.definition.execute(
        { ruleId: "mr-1", action: "allow", status: "paused" },
        makeCtx(),
      );
      expect(identity.updateMailContactRule).toHaveBeenCalledWith("mr-1", {
        action: "allow",
        status: "paused",
      });
      expect(outputText(result)).toContain("Updated mail contact rule id=mr-1.");
    });

    it("declares a schema requiring ruleId and restricting status", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_update_mail_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ ruleId: "mr-1" }).success).toBe(true);
      expect(schema.safeParse({ ruleId: "mr-1", status: "paused" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ruleId: "mr-1", status: "disabled" }).success).toBe(false);
    });
  });

  describe("inkbox_delete_mail_contact_rule", () => {
    it("deletes a mail rule by UUID and summarizes it", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_delete_mail_contact_rule",
      );
      const result = await tool.definition.execute({ ruleId: "mr-1" }, makeCtx());
      expect(identity.deleteMailContactRule).toHaveBeenCalledWith("mr-1");
      expect(result).toMatchObject({ title: expect.stringContaining("mr-1") });
      expect(outputText(result)).toContain("Deleted mail contact rule mr-1.");
    });

    it("declares a schema that requires ruleId", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_delete_mail_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ ruleId: "mr-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ruleId: 42 }).success).toBe(false);
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

  describe("inkbox_create_phone_contact_rule", () => {
    it("creates a phone rule and summarizes the new id", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_create_phone_contact_rule",
      );
      const result = await tool.definition.execute(
        { action: "block", matchType: "exact_number", matchTarget: "+15551234567" },
        makeCtx(),
      );
      expect(identity.createPhoneContactRule).toHaveBeenCalledWith({
        action: "block",
        matchType: "exact_number",
        matchTarget: "+15551234567",
      });
      expect(result).toMatchObject({ title: expect.stringContaining("pr-3") });
      expect(outputText(result)).toContain("Created phone contact rule id=pr-3.");
    });

    it("creates a phone rule without an explicit matchType", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_create_phone_contact_rule",
      );
      await tool.definition.execute({ action: "allow", matchTarget: "+15551234567" }, makeCtx());
      expect(identity.createPhoneContactRule).toHaveBeenCalledWith({
        action: "allow",
        matchType: undefined,
        matchTarget: "+15551234567",
      });
    });

    it("rejects when the identity has no phone number", async () => {
      const identity = makeIdentity({ phoneNumber: null });
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_create_phone_contact_rule",
      );
      await expect(
        tool.definition.execute({ action: "block", matchTarget: "+15551234567" }, makeCtx()),
      ).rejects.toThrow(/no phone number/);
      expect(identity.createPhoneContactRule).not.toHaveBeenCalled();
    });

    it("declares a schema requiring action and a non-empty matchTarget", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_create_phone_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ action: "block", matchTarget: "+15551234567" }).success).toBe(true);
      expect(
        schema.safeParse({ action: "block", matchType: "exact_number", matchTarget: "+1555" })
          .success,
      ).toBe(true);
      expect(schema.safeParse({ matchTarget: "+15551234567" }).success).toBe(false);
      expect(schema.safeParse({ action: "block", matchTarget: "" }).success).toBe(false);
      expect(
        schema.safeParse({ action: "block", matchType: "domain", matchTarget: "+1555" }).success,
      ).toBe(false);
    });
  });

  describe("inkbox_update_phone_contact_rule", () => {
    it("updates action and status on a phone rule", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_update_phone_contact_rule",
      );
      const result = await tool.definition.execute(
        { ruleId: "pr-1", action: "allow", status: "active" },
        makeCtx(),
      );
      expect(identity.updatePhoneContactRule).toHaveBeenCalledWith("pr-1", {
        action: "allow",
        status: "active",
      });
      expect(outputText(result)).toContain("Updated phone contact rule id=pr-1.");
    });

    it("rejects when the identity has no phone number", async () => {
      const identity = makeIdentity({ phoneNumber: null });
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_update_phone_contact_rule",
      );
      await expect(
        tool.definition.execute({ ruleId: "pr-1", action: "allow" }, makeCtx()),
      ).rejects.toThrow(/no phone number/);
      expect(identity.updatePhoneContactRule).not.toHaveBeenCalled();
    });

    it("declares a schema requiring ruleId and restricting action", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_update_phone_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ ruleId: "pr-1" }).success).toBe(true);
      expect(schema.safeParse({ ruleId: "pr-1", action: "allow", status: "paused" }).success).toBe(
        true,
      );
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ruleId: "pr-1", action: "reject" }).success).toBe(false);
    });
  });

  describe("inkbox_delete_phone_contact_rule", () => {
    it("deletes a phone rule by UUID and summarizes it", async () => {
      const identity = makeIdentity();
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_delete_phone_contact_rule",
      );
      const result = await tool.definition.execute({ ruleId: "pr-1" }, makeCtx());
      expect(identity.deletePhoneContactRule).toHaveBeenCalledWith("pr-1");
      expect(result).toMatchObject({ title: expect.stringContaining("pr-1") });
      expect(outputText(result)).toContain("Deleted phone contact rule pr-1.");
    });

    it("rejects when the identity has no phone number", async () => {
      const identity = makeIdentity({ phoneNumber: null });
      const tool = findTool(
        contactRuleTools(makeDeps(identity)),
        "inkbox_delete_phone_contact_rule",
      );
      await expect(tool.definition.execute({ ruleId: "pr-1" }, makeCtx())).rejects.toThrow(
        /no phone number/,
      );
      expect(identity.deletePhoneContactRule).not.toHaveBeenCalled();
    });

    it("declares a schema that requires ruleId", () => {
      const tool = findTool(
        contactRuleTools(makeDeps(makeIdentity())),
        "inkbox_delete_phone_contact_rule",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ ruleId: "pr-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ruleId: 7 }).success).toBe(false);
    });
  });
});
