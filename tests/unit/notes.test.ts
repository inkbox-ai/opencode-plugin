import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { noteTools } from "../../src/tools/notes.js";
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
      list: vi.fn(async () => [
        { id: "note-1", title: "Standup", body: "Daily at 10am" },
        { id: "note-2", title: null, body: "Scratch" },
      ]),
      get: vi.fn(async () => ({ id: "note-1", title: "Standup", body: "Daily at 10am" })),
      create: vi.fn(async () => ({ id: "note-3", title: "New", body: "Fresh" })),
      update: vi.fn(async () => ({ id: "note-1", title: "Renamed", body: "Daily at 10am" })),
      delete: vi.fn(async () => undefined),
    },
  };
}

function findTool(tools: ReturnType<typeof noteTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("noteTools", () => {
  it("registers the five note tools in the notes group", () => {
    const tools = noteTools(makeDeps(makeClient()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_list_notes",
      "inkbox_get_note",
      "inkbox_create_note",
      "inkbox_update_note",
      "inkbox_delete_note",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("notes");
      expect(tool.sensitive).toBeFalsy();
    }
  });

  it("enables list/get/create by default and keeps update/delete opt-in", () => {
    const tools = noteTools(makeDeps(makeClient()));
    const enabledByDefault = ["inkbox_list_notes", "inkbox_get_note", "inkbox_create_note"];
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(enabledByDefault.includes(tool.name));
    }
  });

  describe("inkbox_list_notes", () => {
    it("lists notes with the default limit when no filters are given", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_list_notes");
      const result = await tool.definition.execute({}, makeCtx());
      expect(client.notes.list).toHaveBeenCalledWith({
        q: undefined,
        order: undefined,
        limit: 50,
      });
      const text = outputText(result);
      expect(text).toContain("Returned 2 note(s).");
      expect(text).toContain('"id": "note-1"');
    });

    it("passes search, order, and limit through to the SDK", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_list_notes");
      await tool.definition.execute({ q: "standup", order: "name", limit: 5 }, makeCtx());
      expect(client.notes.list).toHaveBeenCalledWith({
        q: "standup",
        order: "name",
        limit: 5,
      });
    });

    it("declares a schema that bounds limit to 1..200 and restricts order", () => {
      const tool = findTool(noteTools(makeDeps(makeClient())), "inkbox_list_notes");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ q: "x", order: "recent", limit: 200 }).success).toBe(true);
      expect(schema.safeParse({ order: "name" }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ order: "alphabetical" }).success).toBe(false);
    });
  });

  describe("inkbox_get_note", () => {
    it("fetches a note by UUID and returns it as JSON", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_get_note");
      const result = await tool.definition.execute({ noteId: "note-1" }, makeCtx());
      expect(client.notes.get).toHaveBeenCalledWith("note-1");
      const text = outputText(result);
      expect(text).toContain('"id": "note-1"');
      expect(text).toContain('"body": "Daily at 10am"');
    });

    it("declares a schema that requires noteId", () => {
      const tool = findTool(noteTools(makeDeps(makeClient())), "inkbox_get_note");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "note-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ noteId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_create_note", () => {
    it("creates a note with body and title and summarizes the new id", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_create_note");
      const result = await tool.definition.execute({ body: "Fresh", title: "New" }, makeCtx());
      expect(client.notes.create).toHaveBeenCalledWith({ body: "Fresh", title: "New" });
      expect(result).toMatchObject({ title: expect.stringContaining("note-3") });
      expect(outputText(result)).toContain("Created note id=note-3.");
    });

    it("creates a note without a title", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_create_note");
      await tool.definition.execute({ body: "Fresh" }, makeCtx());
      expect(client.notes.create).toHaveBeenCalledWith({ body: "Fresh", title: undefined });
    });

    it("declares a schema that requires a non-empty body", () => {
      const tool = findTool(noteTools(makeDeps(makeClient())), "inkbox_create_note");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ body: "x" }).success).toBe(true);
      expect(schema.safeParse({ body: "x", title: "t" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ body: "" }).success).toBe(false);
      expect(schema.safeParse({ body: "x", title: 5 }).success).toBe(false);
    });
  });

  describe("inkbox_update_note", () => {
    it("updates title and body together", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_update_note");
      const result = await tool.definition.execute(
        { noteId: "note-1", title: "Renamed", body: "New body" },
        makeCtx(),
      );
      expect(client.notes.update).toHaveBeenCalledWith("note-1", {
        title: "Renamed",
        body: "New body",
      });
      expect(outputText(result)).toContain("Updated note note-1.");
    });

    it("passes title=null through so the server clears the title", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_update_note");
      await tool.definition.execute({ noteId: "note-1", title: null }, makeCtx());
      expect(client.notes.update).toHaveBeenCalledWith("note-1", { title: null });
    });

    it("omits fields that were not provided from the patch payload", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_update_note");
      await tool.definition.execute({ noteId: "note-1", body: "Only body" }, makeCtx());
      const patch = (client.notes.update as any).mock.calls[0][1];
      expect(Object.keys(patch)).toEqual(["body"]);
      expect(patch).toEqual({ body: "Only body" });
    });

    it("declares a schema accepting nullable title and non-empty body", () => {
      const tool = findTool(noteTools(makeDeps(makeClient())), "inkbox_update_note");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "n" }).success).toBe(true);
      expect(schema.safeParse({ noteId: "n", title: null }).success).toBe(true);
      expect(schema.safeParse({ noteId: "n", title: "t", body: "b" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ noteId: "n", body: "" }).success).toBe(false);
      expect(schema.safeParse({ noteId: "n", title: 7 }).success).toBe(false);
    });
  });

  describe("inkbox_delete_note", () => {
    it("deletes the note by UUID and summarizes it", async () => {
      const client = makeClient();
      const tool = findTool(noteTools(makeDeps(client)), "inkbox_delete_note");
      const result = await tool.definition.execute({ noteId: "note-1" }, makeCtx());
      expect(client.notes.delete).toHaveBeenCalledWith("note-1");
      expect(result).toMatchObject({ title: expect.stringContaining("note-1") });
      expect(outputText(result)).toContain("Deleted note note-1.");
    });

    it("declares a schema that requires noteId", () => {
      const tool = findTool(noteTools(makeDeps(makeClient())), "inkbox_delete_note");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ noteId: "note-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ noteId: 42 }).success).toBe(false);
    });
  });
});
