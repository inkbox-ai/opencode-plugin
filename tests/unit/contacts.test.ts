import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { contactTools } from "../../src/tools/contacts.js";
import type { ToolDeps } from "../../src/tools/types.js";

function makeDeps(
  clientStub: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => ({})),
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

function makeClient() {
  const contact = {
    id: "contact-1",
    preferredName: "Ada Lovelace",
    emails: [{ value: "ada@example.com", label: "work", isPrimary: true }],
    phones: [],
  };
  return {
    contacts: {
      lookup: vi.fn(async () => [contact]),
      get: vi.fn(async () => contact),
      list: vi.fn(async () => [contact, { id: "contact-2" }]),
      create: vi.fn(async () => contact),
      update: vi.fn(async () => contact),
      delete: vi.fn(async () => undefined),
    },
  };
}

function findTool(tools: ReturnType<typeof contactTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("contactTools", () => {
  it("registers the six contact tools in the contacts group, all enabled by default", () => {
    const tools = contactTools(makeDeps(makeClient()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_lookup_contact",
      "inkbox_get_contact",
      "inkbox_list_contacts",
      "inkbox_create_contact",
      "inkbox_update_contact",
      "inkbox_delete_contact",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("contacts");
      expect(tool.defaultEnabled).toBe(true);
      expect(tool.sensitive).toBeFalsy();
    }
  });

  describe("inkbox_lookup_contact", () => {
    it("looks up contacts by exact email and summarizes the match count", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_lookup_contact");
      const result = await tool.definition.execute({ email: "ada@example.com" }, makeCtx());
      expect(client.contacts.lookup).toHaveBeenCalledWith(
        expect.objectContaining({ email: "ada@example.com" }),
      );
      const text = outputText(result);
      expect(text).toContain("Found 1 contact(s).");
      expect(text).toContain('"id": "contact-1"');
    });

    it("passes substring and domain filters through to the SDK", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_lookup_contact");
      await tool.definition.execute({ emailDomain: "example.com" }, makeCtx());
      expect(client.contacts.lookup).toHaveBeenCalledWith(
        expect.objectContaining({ emailDomain: "example.com" }),
      );
      await tool.definition.execute({ phoneContains: "555" }, makeCtx());
      expect(client.contacts.lookup).toHaveBeenCalledWith(
        expect.objectContaining({ phoneContains: "555" }),
      );
    });

    it("declares a schema where every filter is an optional string", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_lookup_contact");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ phone: "+15551234567" }).success).toBe(true);
      expect(schema.safeParse({ email: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_get_contact", () => {
    it("fetches a contact by UUID and returns the full record as JSON", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_get_contact");
      const result = await tool.definition.execute({ contactId: "contact-1" }, makeCtx());
      expect(client.contacts.get).toHaveBeenCalledWith("contact-1");
      const text = outputText(result);
      expect(text).toContain('"id": "contact-1"');
      expect(text).toContain('"preferredName": "Ada Lovelace"');
    });

    it("declares a schema that requires contactId", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_get_contact");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ contactId: "contact-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe("inkbox_list_contacts", () => {
    it("lists contacts with default paging", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_list_contacts");
      const result = await tool.definition.execute({}, makeCtx());
      expect(client.contacts.list).toHaveBeenCalledWith({
        q: undefined,
        order: undefined,
        limit: 50,
        offset: 0,
      });
      expect(outputText(result)).toContain("Returned 2 contact(s).");
    });

    it("passes search text, sort order, and explicit paging through to the SDK", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_list_contacts");
      await tool.definition.execute({ q: "ada", order: "name", limit: 5, offset: 10 }, makeCtx());
      expect(client.contacts.list).toHaveBeenCalledWith({
        q: "ada",
        order: "name",
        limit: 5,
        offset: 10,
      });
    });

    it("declares a schema that bounds limit to 1..200 and restricts order values", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_list_contacts");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ q: "ada", order: "recent", limit: 200, offset: 0 }).success).toBe(
        true,
      );
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ order: "alphabetical" }).success).toBe(false);
    });
  });

  describe("inkbox_create_contact", () => {
    it("creates a contact with normalized email/phone entries and summarizes the id", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_create_contact");
      const result = await tool.definition.execute(
        {
          preferredName: "Ada Lovelace",
          companyName: "Analytical Engines",
          emails: [{ value: "ada@example.com", isPrimary: true }],
          phones: [{ value: "+15551234567", label: "mobile" }],
        },
        makeCtx(),
      );
      expect(client.contacts.create).toHaveBeenCalledWith({
        preferredName: "Ada Lovelace",
        companyName: "Analytical Engines",
        emails: [{ value: "ada@example.com", label: null, isPrimary: true }],
        phones: [{ value: "+15551234567", label: "mobile", isPrimary: false }],
      });
      expect(result).toMatchObject({ title: expect.stringContaining("contact-1") });
      expect(outputText(result)).toContain("Created contact id=contact-1.");
    });

    it("omits fields that were not provided", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_create_contact");
      await tool.definition.execute({ givenName: "Ada" }, makeCtx());
      expect(client.contacts.create).toHaveBeenCalledWith({ givenName: "Ada" });
    });

    it("declares a schema that types email/phone entries", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_create_contact");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(
        schema.safeParse({
          preferredName: "Ada",
          emails: [{ value: "ada@example.com", label: "work", isPrimary: true }],
        }).success,
      ).toBe(true);
      expect(schema.safeParse({ emails: [{ label: "work" }] }).success).toBe(false);
      expect(schema.safeParse({ phones: "+15551234567" }).success).toBe(false);
    });
  });

  describe("inkbox_update_contact", () => {
    it("updates only the provided fields", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_update_contact");
      const result = await tool.definition.execute(
        {
          contactId: "contact-1",
          givenName: "Ada",
          phones: [{ value: "+15551234567" }],
        },
        makeCtx(),
      );
      expect(client.contacts.update).toHaveBeenCalledWith("contact-1", {
        givenName: "Ada",
        phones: [{ value: "+15551234567", label: null, isPrimary: false }],
      });
      expect(result).toMatchObject({ title: expect.stringContaining("contact-1") });
      expect(outputText(result)).toContain("Updated contact id=contact-1.");
    });

    it("passes explicit nulls through so fields can be cleared", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_update_contact");
      await tool.definition.execute(
        { contactId: "contact-1", notes: null, emails: null, phones: null },
        makeCtx(),
      );
      expect(client.contacts.update).toHaveBeenCalledWith("contact-1", {
        notes: null,
        emails: null,
        phones: null,
      });
    });

    it("declares a schema that requires contactId and accepts nullable fields", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_update_contact");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ contactId: "contact-1" }).success).toBe(true);
      expect(schema.safeParse({ contactId: "contact-1", notes: null, emails: null }).success).toBe(
        true,
      );
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ contactId: "contact-1", emails: [{}] }).success).toBe(false);
    });
  });

  describe("inkbox_delete_contact", () => {
    it("deletes the contact by UUID and confirms it", async () => {
      const client = makeClient();
      const tool = findTool(contactTools(makeDeps(client)), "inkbox_delete_contact");
      const result = await tool.definition.execute({ contactId: "contact-1" }, makeCtx());
      expect(client.contacts.delete).toHaveBeenCalledWith("contact-1");
      expect(result).toMatchObject({ title: expect.stringContaining("contact-1") });
      expect(outputText(result)).toContain("Deleted contact contact-1.");
    });

    it("declares a schema that requires contactId", () => {
      const tool = findTool(contactTools(makeDeps(makeClient())), "inkbox_delete_contact");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ contactId: "contact-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ contactId: 7 }).success).toBe(false);
    });
  });
});
