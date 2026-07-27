import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { accessTools } from "../../src/tools/access.js";
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
  return {
    notes: {
      access: {
        list: vi.fn(async () => [
          { id: "grant-3", noteId: "note-1", identityId: "identity-1" },
          { id: "grant-4", noteId: "note-1", identityId: "identity-2" },
        ]),
        grant: vi.fn(async () => ({ id: "grant-5", noteId: "note-1", identityId: "identity-3" })),
        revoke: vi.fn(async () => undefined),
      },
    },
  };
}

function findTool(tools: ReturnType<typeof accessTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("accessTools", () => {
  it("registers the three note access tools in the access group", () => {
    const tools = accessTools(makeDeps(makeClient()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_note_access",
      "inkbox_grant_note_access",
      "inkbox_revoke_note_access",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("access");
      expect(tool.sensitive).toBeFalsy();
    }
  });

  it("keeps every access tool opt-in", () => {
    const tools = accessTools(makeDeps(makeClient()));
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(false);
    }
  });

  describe("inkbox_list_note_access", () => {
    it("lists grants for the note and reports the count", async () => {
      const client = makeClient();
      const tool = findTool(accessTools(makeDeps(client)), "inkbox_list_note_access");
      const result = await tool.definition.execute({ noteId: "note-1" }, makeCtx());
      expect(client.notes.access.list).toHaveBeenCalledWith("note-1");
      const text = outputText(result);
      expect(text).toContain("Returned 2 note access grant(s).");
      expect(text).toContain('"identityId": "identity-2"');
    });

    it("declares a schema that requires noteId", () => {
      const tool = findTool(accessTools(makeDeps(makeClient())), "inkbox_list_note_access");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "note-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ noteId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_grant_note_access", () => {
    it("grants the identity access and returns the grant as JSON", async () => {
      const client = makeClient();
      const tool = findTool(accessTools(makeDeps(client)), "inkbox_grant_note_access");
      const result = await tool.definition.execute(
        { noteId: "note-1", identityId: "identity-3" },
        makeCtx(),
      );
      expect(client.notes.access.grant).toHaveBeenCalledWith("note-1", "identity-3");
      const text = outputText(result);
      expect(text).toContain('"id": "grant-5"');
      expect(text).toContain('"identityId": "identity-3"');
    });

    it("declares a schema that requires noteId and identityId", () => {
      const tool = findTool(accessTools(makeDeps(makeClient())), "inkbox_grant_note_access");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "n", identityId: "i" }).success).toBe(true);
      expect(schema.safeParse({ noteId: "n" }).success).toBe(false);
      expect(schema.safeParse({ noteId: "n", identityId: 7 }).success).toBe(false);
    });
  });

  describe("inkbox_revoke_note_access", () => {
    it("revokes the identity's access and summarizes it", async () => {
      const client = makeClient();
      const tool = findTool(accessTools(makeDeps(client)), "inkbox_revoke_note_access");
      const result = await tool.definition.execute(
        { noteId: "note-1", identityId: "identity-1" },
        makeCtx(),
      );
      expect(client.notes.access.revoke).toHaveBeenCalledWith("note-1", "identity-1");
      expect(outputText(result)).toContain("Revoked identity identity-1 access to note note-1.");
    });

    it("declares a schema that requires noteId and identityId", () => {
      const tool = findTool(accessTools(makeDeps(makeClient())), "inkbox_revoke_note_access");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "n", identityId: "i" }).success).toBe(true);
      expect(schema.safeParse({ identityId: "i" }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });
});
