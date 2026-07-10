import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { callReadTools } from "../../src/tools/call-reads.js";
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
    listCalls: vi.fn(async () => [
      { id: "call-1", direction: "inbound" },
      { id: "call-2", direction: "outbound" },
    ]),
    listTranscripts: vi.fn(async () => [
      { seq: 1, party: "remote", text: "Hello?" },
      { seq: 2, party: "local", text: "Hi, this is the agent." },
      { seq: 3, party: "remote", text: "Great, thanks." },
    ]),
  };
}

function findTool(tools: ReturnType<typeof callReadTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("callReadTools", () => {
  it("registers both call read tools in the calls group, enabled by default", () => {
    const tools = callReadTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual(["inkbox_list_calls", "inkbox_list_call_transcripts"]);
    for (const tool of tools) {
      expect(tool.group).toBe("calls");
      expect(tool.defaultEnabled).toBe(true);
      expect(tool.sensitive).toBeFalsy();
    }
  });

  describe("inkbox_list_calls", () => {
    it("lists calls with default paging", async () => {
      const identity = makeIdentity();
      const tool = findTool(callReadTools(makeDeps(identity)), "inkbox_list_calls");
      const result = await tool.definition.execute({}, makeCtx());
      expect(identity.listCalls).toHaveBeenCalledWith({ limit: 25, offset: 0 });
      const text = outputText(result);
      expect(text).toContain("Returned 2 call(s).");
      expect(text).toContain('"id": "call-1"');
    });

    it("passes explicit paging through to the SDK", async () => {
      const identity = makeIdentity();
      const tool = findTool(callReadTools(makeDeps(identity)), "inkbox_list_calls");
      await tool.definition.execute({ limit: 5, offset: 10 }, makeCtx());
      expect(identity.listCalls).toHaveBeenCalledWith({ limit: 5, offset: 10 });
    });

    it("declares a schema that bounds limit to 1..200 and offset to >= 0", () => {
      const tool = findTool(callReadTools(makeDeps(makeIdentity())), "inkbox_list_calls");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ limit: 200, offset: 0 }).success).toBe(true);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ limit: 201 }).success).toBe(false);
      expect(schema.safeParse({ offset: -1 }).success).toBe(false);
      expect(schema.safeParse({ limit: "ten" }).success).toBe(false);
    });
  });

  describe("inkbox_list_call_transcripts", () => {
    it("fetches transcript segments for the given call UUID", async () => {
      const identity = makeIdentity();
      const tool = findTool(callReadTools(makeDeps(identity)), "inkbox_list_call_transcripts");
      const result = await tool.definition.execute({ callId: "call-1" }, makeCtx());
      expect(identity.listTranscripts).toHaveBeenCalledWith("call-1");
      const text = outputText(result);
      expect(text).toContain("Returned 3 transcript segment(s) for call call-1.");
      expect(text).toContain('"party": "remote"');
      expect(text).toContain('"text": "Hi, this is the agent."');
    });

    it("declares a schema that requires callId", () => {
      const tool = findTool(
        callReadTools(makeDeps(makeIdentity())),
        "inkbox_list_call_transcripts",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ callId: "call-1" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ callId: 42 }).success).toBe(false);
    });
  });
});
