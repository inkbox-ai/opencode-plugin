import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/gateway/state.js";
import { readSlackFile, uploadSlackFile } from "../../src/slack-upload.js";
import { slackTools } from "../../src/tools/slack.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slack-file-"));
  dirs.push(dir);
  writeFileSync(join(dir, "chart.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const route = {
    identityId: "identity",
    connectionId: "connection",
    workspaceId: "TWORK",
    conversationId: "CROOM",
    actorId: "UACTOR",
    author: "TWORK:UACTOR",
    threadTs: "1.0",
    messageTs: "1.1",
    sourceEventId: "event",
  };
  const args = {
    connectionId: "connection",
    conversationId: "CROOM",
    filePath: "chart.png",
    idempotencyKey: "model-key",
  };
  const abort = new AbortController();
  const ctx: any = {
    sessionID: "session",
    messageID: "assistant",
    directory: dir,
    abort: abort.signal,
  };
  const store = createStateStore(dir);
  store.saveTurn({
    id: "turn",
    messageID: "parent",
    sessionID: "session",
    ownerId: "owner",
    leaseUntil: Date.now() + 60000,
    state: "submitted",
    chatKey: "chat",
    kind: "normal",
    text: "",
    deliver: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    replyTarget: { channel: "slack", slack: route },
  } as any);
  const message = {
    data: {
      info: { role: "assistant", parentID: "parent" },
      parts: [
        {
          type: "tool",
          tool: "inkbox_slack_upload_file",
          callID: "call",
          state: { status: "running", input: args },
        },
      ],
    },
  };
  const slack = {
    listConnections: vi.fn(async () => ({
      connections: [
        { id: "connection", identityId: "identity", status: "connected", workspaceId: "TWORK" },
      ],
    })),
    uploadFile: vi.fn(async () => ({
      id: "operation",
      status: "succeeded",
      fileId: "FUPLOAD",
      connectionId: "connection",
      conversationId: "CROOM",
    })),
  };
  const deps: any = {
    store,
    enabled: () => true,
    approve: vi.fn(async () => {}),
    runtime: { getClient: async () => ({ slack }), getIdentity: async () => ({ id: "identity" }) },
    opencode: { session: { message: vi.fn(async () => message) } },
  };
  return { dir, ctx, abort, args, deps, store, slack, message };
}
describe("actual source-bound Slack file delivery", () => {
  it("uploads actual local bytes in the original thread and journals only a fingerprint/result", async () => {
    const d = fixture();
    expect(await uploadSlackFile(d.deps, d.args, d.ctx)).toMatchObject({
      status: "succeeded",
      fileId: "FUPLOAD",
    });
    expect(d.slack.uploadFile).toHaveBeenCalledWith(
      "connection",
      expect.objectContaining({
        filename: "chart.png",
        contentBase64: "iVBORw0KGgo=",
        threadTs: "1.0",
      }),
    );
    const journal = JSON.stringify(d.store.read().slackSends);
    expect(journal).not.toContain("iVBOR");
    expect(journal).not.toContain("chart.png");
    expect(await uploadSlackFile(d.deps, d.args, d.ctx)).toMatchObject({ deduplicated: true });
    expect(d.slack.uploadFile).toHaveBeenCalledOnce();
  });
  it("does not replay an uncertain upload even if the caller changes its idempotency key", async () => {
    const d = fixture();
    d.slack.uploadFile.mockRejectedValue(new Error("response lost"));
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("response lost");
    d.args.idempotencyKey = "fresh-key";
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("unconfirmed outcome");
    expect(d.slack.uploadFile).toHaveBeenCalledOnce();
  });
  it("does not replay an uncertain identical file through a new model tool call", async () => {
    const d = fixture();
    d.slack.uploadFile.mockRejectedValue(new Error("response lost"));
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("response lost");
    d.message.data.parts[0]!.callID = "replacement-call";
    d.args.idempotencyKey = "replacement-key";
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("unconfirmed outcome");
    expect(d.slack.uploadFile).toHaveBeenCalledOnce();
  });
  it("rejects a delegated child session without an original owned source", async () => {
    const d = fixture();
    d.ctx.sessionID = "child-session";
    d.deps.opencode.session.get = vi.fn(async () => ({
      data: { id: "child-session", parentID: "session" },
    }));
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("Child-session uploads");
    expect(d.slack.uploadFile).not.toHaveBeenCalled();
  });
  it("shows the actual resolved file and destination in the native approval prompt", async () => {
    const d = fixture();
    vi.stubEnv("INKBOX_OPENCODE_HOME", d.dir);
    d.ctx.ask = vi.fn(async () => {});
    const tool = slackTools({
      runtime: d.deps.runtime,
      opencode: d.deps.opencode,
      config: {
        gateway: { slackEnabled: true },
        outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 1000 },
      },
    } as any).find((tool) => tool.name === "inkbox_slack_upload_file")!;
    await tool.definition.execute(d.args, d.ctx);
    expect(d.ctx.ask.mock.calls[0][0].patterns).toEqual([
      expect.stringMatching(/^slack-file:[a-f0-9]{64}$/),
    ]);
    expect(d.ctx.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          filePath: join(d.dir, "chart.png"),
          filename: "chart.png",
          conversationId: "CROOM",
        }),
      }),
    );
  });
  it("does not treat unknown result as success or resend after restart", async () => {
    const d = fixture();
    d.slack.uploadFile.mockResolvedValue({ id: "unknown-operation", status: "unknown" } as any);
    expect(await uploadSlackFile(d.deps, d.args, d.ctx)).toMatchObject({ status: "unknown" });
    d.deps.store = createStateStore(d.dir);
    expect(await uploadSlackFile(d.deps, d.args, d.ctx)).toMatchObject({ status: "unknown" });
    expect(d.slack.uploadFile).toHaveBeenCalledOnce();
  });
  it("rechecks Stop after approval and refuses all file effects", async () => {
    const d = fixture();
    d.deps.approve.mockImplementation(async () =>
      d.store.updateTurn("turn", { state: "interrupted", executionFenced: true }),
    );
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("no longer owns");
    expect(d.slack.uploadFile).not.toHaveBeenCalled();
    expect(d.store.read().slackSends).toBeUndefined();
  });
  it("rechecks source ownership after the connection await", async () => {
    const d = fixture();
    d.slack.listConnections.mockImplementation(async () => {
      d.store.updateTurn("turn", { ownerId: "new-owner" });
      return {
        connections: [
          { id: "connection", identityId: "identity", status: "connected", workspaceId: "TWORK" },
        ],
      };
    });
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("no longer owns");
    expect(d.slack.uploadFile).not.toHaveBeenCalled();
  });
  it("fences an old source after the Slack connection is replaced", async () => {
    const d = fixture();
    const turn = d.store.getTurn("turn")!;
    d.store.updateTurn("turn", {
      replyTarget: {
        ...turn.replyTarget!,
        slack: { ...turn.replyTarget!.slack!, connectionGeneration: 1 },
      },
    });
    d.slack.listConnections.mockResolvedValue({
      connections: [
        {
          id: "connection",
          identityId: "identity",
          status: "connected",
          workspaceId: "TWORK",
          generation: 2,
        },
      ],
    } as any);
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("not connected");
    expect(d.slack.uploadFile).not.toHaveBeenCalled();
  });
  it("retains the outcome of a POST crossed before Stop without replay", async () => {
    const d = fixture();
    d.slack.uploadFile.mockImplementation(async () => {
      d.store.updateTurn("turn", { state: "interrupted", executionFenced: true });
      return {
        id: "operation",
        status: "succeeded",
        fileId: "FUPLOAD",
        connectionId: "connection",
        conversationId: "CROOM",
      };
    });
    expect(await uploadSlackFile(d.deps, d.args, d.ctx)).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(d.store.read().slackSends)).toContain("FUPLOAD");
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow("no longer owns");
    expect(d.slack.uploadFile).toHaveBeenCalledOnce();
  });
  it.each(["missing", "ambiguous", "wrong-parent", "aborted"])(
    "requires an exact active host tool call: %s",
    async (caseName) => {
      const d = fixture();
      if (caseName === "missing") d.message.data.parts = [];
      if (caseName === "ambiguous") d.message.data.parts.push(d.message.data.parts[0]!);
      if (caseName === "wrong-parent") d.message.data.info.role = "user";
      if (caseName === "aborted") d.abort.abort();
      await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow();
      expect(d.slack.uploadFile).not.toHaveBeenCalled();
    },
  );
  it("prevents an active upload from drifting to a successor's thread", async () => {
    const d = fixture();
    Object.assign(d.args, { threadTs: "new-thread" });
    await expect(uploadSlackFile(d.deps, d.args, d.ctx)).rejects.toThrow(
      "cannot switch Slack threads",
    );
    expect(d.slack.uploadFile).not.toHaveBeenCalled();
  });
  it("allows an explicitly authorized independent destination without inheriting a reply thread", async () => {
    const d = fixture();
    d.args.conversationId = "COTHER";
    await uploadSlackFile(d.deps, d.args, d.ctx);
    expect((d.slack.uploadFile.mock.calls as any[])[0]?.[1]).toMatchObject({
      conversationId: "COTHER",
      threadTs: null,
    });
  });
  it("rejects oversized/empty files and URLs before dispatch", async () => {
    const d = fixture();
    truncateSync(join(d.dir, "chart.png"), 10 * 1024 * 1024 + 1);
    await expect(readSlackFile("chart.png", d.dir)).rejects.toThrow("1 byte to 10 MiB");
    truncateSync(join(d.dir, "chart.png"), 0);
    await expect(readSlackFile("chart.png", d.dir)).rejects.toThrow();
    await expect(readSlackFile("https://example.test/file", d.dir)).rejects.toThrow("local file");
    await expect(readSlackFile(".", d.dir)).rejects.toThrow("regular files");
  });
  it("published SDK sends real content_base64 and a source-stable idempotency header", async () => {
    const d = fixture();
    const requests: Array<{ body: any; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        requests.push({
          body: JSON.parse(init.body),
          key: new Headers(init.headers).get("Idempotency-Key"),
        });
        return new Response(
          JSON.stringify({
            id: "operation",
            status: "succeeded",
            operation: "file_upload",
            connection_id: "connection",
            conversation_id: "CROOM",
            file_id: "FUPLOAD",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const client = new Inkbox({ apiKey: "test-key", baseUrl: "https://example.test" });
    d.slack.uploadFile = client.slack.uploadFile.bind(client.slack) as any;
    await uploadSlackFile(d.deps, d.args, d.ctx);
    expect(requests[0]?.body).toMatchObject({
      content_base64: readFileSync(join(d.dir, "chart.png")).toString("base64"),
      thread_ts: "1.0",
    });
    expect(requests[0]?.key).toMatch(/^opencode:upload:/);
  });
});
