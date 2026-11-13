import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { resolveConfig } from "../../src/config.js";
import { createStateStore } from "../../src/gateway/state.js";
import type { HostClient } from "../../src/host/types.js";
import { RemoteTools } from "../../src/remote-tools.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness(incoming = false) {
  const home = mkdtempSync(join(tmpdir(), "inkbox-opencode-remote-"));
  roots.push(home);
  const config = resolveConfig({ gateway: { outboundApproval: "auto" } });
  const client = {
    _apiKey: "synthetic",
    _baseUrl: "https://example.test",
    whoami: vi.fn(async () => ({ authSubtype: "api_key.agent_scoped.claimed" })),
  };
  const runtime = {
    getClient: async () => client,
    getIdentity: async () => ({ id: "identity" }),
  } as unknown as InkboxRuntime;
  const info = { id: "assistant", sessionID: "session", parentID: "user", role: "assistant" };
  const host = { session: { message: async () => ({ data: { info } }) } } as unknown as HostClient;
  const store = createStateStore(home);
  if (incoming)
    store.saveTurn({
      id: "turn",
      messageID: "user",
      sessionID: "session",
      state: "submitted",
      chatKey: "chat",
      kind: "normal",
      text: "synthetic",
      deliver: true,
      ownerId: "owner",
      createdAt: 1,
      updatedAt: 1,
      replyTarget: { channel: "sms", to: "+15550000001" },
    });
  const relay = new RemoteTools(runtime, config, host, home, home);
  const tools = relay.wrap({});
  const abort = new AbortController();
  const context = {
    sessionID: "session",
    messageID: "assistant",
    agent: "agent",
    directory: home,
    worktree: home,
    abort: abort.signal,
    metadata: () => {},
    ask: vi.fn(async () => {}),
  } satisfies ToolContext;
  const descriptors = [
    {
      name: "inkbox_synthetic",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 2 } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      description: "First",
    },
  ];
  const calls: Record<string, unknown>[] = [];
  const result = {
    content: [{ type: "text", text: "accepted" }],
    structuredContent: { id: "receipt" },
    _meta: { source: "synthetic" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      let value: unknown;
      if (request.method === "server/discover") value = { supportedVersions: ["2026-07-28"] };
      else if (request.method === "tools/list") value = { tools: descriptors };
      else {
        calls.push(request.params);
        value = request.params.requestState
          ? result
          : { resultType: "input_required", requestState: "state" };
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result: value });
    }),
  );
  const execute = async (
    name: string,
    args: Record<string, unknown>,
    callID = "native-call",
    v2 = false,
  ) => {
    if (!v2) relay.before({ sessionID: context.sessionID, callID, tool: name }, { args });
    const value = await tools[name]!.execute(
      args,
      v2 ? ({ ...context, callID } as ToolContext) : context,
    );
    return typeof value === "string" ? JSON.parse(value) : JSON.parse(value.output);
  };
  return { relay, tools, execute, info, descriptors, calls, result, context, store, abort, client };
}

describe("native remote relay", () => {
  it.each([false, true])("keeps full schemas/results and native identities (V2 %s)", async (v2) => {
    const h = harness();
    expect(await h.execute("inkbox_remote_tools", {}, "list", v2)).toMatchObject({
      tools: h.descriptors,
    });
    const args = { name: "inkbox_synthetic", arguments: { text: "hello" } };
    expect(await h.execute("inkbox_remote_call", args, "first", v2)).toEqual(h.result);
    await h.execute("inkbox_remote_call", args, "first", v2);
    await h.execute("inkbox_remote_call", { ...args }, "second", v2);
    expect(h.calls.map((call) => call.requestState)).toEqual([
      undefined,
      "state",
      "state",
      undefined,
      "state",
    ]);
    expect(h.context.ask).toHaveBeenCalledTimes(3);
    const count = h.calls.length;
    await expect(
      h.execute(
        "inkbox_remote_call",
        { name: "inkbox_synthetic", arguments: { text: "x" } },
        "bad",
        v2,
      ),
    ).rejects.toThrow("schema");
    expect(h.calls).toHaveLength(count);
    h.relay.close();
  });
  it("refreshes only between user turns and rejects removed tools", async () => {
    const h = harness();
    await h.execute("inkbox_remote_tools", {});
    h.descriptors[0]!.description = "Changed";
    expect(await h.execute("inkbox_remote_tools", {})).toMatchObject({
      tools: [{ description: "First" }],
    });
    h.info.parentID = "next";
    expect(await h.execute("inkbox_remote_tools", {})).toMatchObject({
      tools: [{ description: "Changed" }],
    });
    h.descriptors.push({ ...h.descriptors[0]!, name: "inkbox_new" });
    h.info.parentID = "third";
    expect((await h.execute("inkbox_remote_tools", {})).tools).toHaveLength(2);
    h.descriptors.splice(0);
    h.info.parentID = "fourth";
    expect((await h.execute("inkbox_remote_tools", {})).tools).toHaveLength(0);
    await expect(
      h.execute("inkbox_remote_call", { name: "inkbox_synthetic", arguments: { text: "ok" } }),
    ).rejects.toThrow("unavailable");
  });
  it("separates incoming approval from interactive turns and fences retirement", async () => {
    const h = harness(true);
    await h.execute("inkbox_remote_call", { name: "inkbox_synthetic", arguments: { text: "ok" } });
    expect(h.context.ask).not.toHaveBeenCalled();
    h.store.updateTurn("turn", { state: "interrupted" });
    await expect(
      h.execute("inkbox_remote_call", { name: "inkbox_synthetic", arguments: { text: "ok" } }),
    ).rejects.toThrow("no longer");
    h.info.parentID = "browser";
    h.context.ask.mockRejectedValueOnce(new Error("declined"));
    await expect(
      h.execute("inkbox_remote_call", { name: "inkbox_synthetic", arguments: { text: "ok" } }),
    ).rejects.toThrow("declined");
    expect(h.calls).toHaveLength(2);
    h.abort.abort();
    await expect(h.execute("inkbox_remote_tools", {})).rejects.toThrow();
  });
  it("refuses absent native identity and unknown authority", async () => {
    const h = harness();
    await expect(
      h.tools.inkbox_remote_call!.execute(
        { name: "inkbox_synthetic", arguments: { text: "ok" } },
        h.context,
      ),
    ).rejects.toThrow("native tool-call");
    h.client.whoami.mockResolvedValue({ authSubtype: "unknown" });
    h.info.parentID = "other";
    await expect(h.execute("inkbox_remote_tools", {})).rejects.toThrow("authority");
    expect(h.calls).toHaveLength(0);
  });
});
