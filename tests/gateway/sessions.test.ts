import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { defaultGatewayConfig } from "../../src/config.js";
import { getHostedCall, saveHostedCall } from "../../src/gateway/hosted-call-registry.js";
import { createSessionManager, extractText } from "../../src/gateway/sessions.js";
import { createStateStore, type DurableTurn } from "../../src/gateway/state.js";
import type { InboundMessage } from "../../src/gateway/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  delete process.env.INKBOX_OPENCODE_HOME;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeIdentity() {
  return {
    agentHandle: "test-agent",
    emailAddress: "test-agent@inkboxmail.com",
    phoneNumber: { number: "+15559990000" },
    imessageEnabled: true,
    sendEmail: vi.fn(async () => ({ id: "email-1" })),
    sendText: vi.fn(async () => ({ id: "sms-1" })),
    sendIMessage: vi.fn(async () => ({ id: "im-1" })),
  };
}

function makeManager(existingDir?: string) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gw-sessions-"));
  if (!existingDir) tmpDirs.push(dir);
  const state = createStateStore(dir);
  const identity = makeIdentity();
  const inkbox = { getIdentity: vi.fn(async () => identity), getClient: vi.fn() };
  const messages = new Map<string, any[]>();
  const statuses: Record<string, { type: string }> = {};
  let created = 0;
  let reply = "reply";
  let autoComplete = true;
  const opencode = {
    tool: {
      ids: vi.fn(async () => ({
        data: ["bash", "edit", "task", "inkbox_send_sms", "inkbox_send_email"],
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: `sess-${++created}` } })),
      get: vi.fn(async (o: { path: { id: string } }) => ({
        data: { id: o.path.id, directory: "/proj" },
      })),
      promptAsync: vi.fn(async (o: any) => {
        const rows = messages.get(o.path.id) ?? [];
        rows.push({
          info: { id: o.body.messageID, role: "user" },
          parts: o.body.parts,
        });
        if (autoComplete) {
          rows.push({
            info: {
              id: `assistant-${o.body.messageID}`,
              role: "assistant",
              parentID: o.body.messageID,
              time: { completed: Date.now() },
              finish: "stop",
            },
            parts: [{ type: "text", text: reply }],
          });
          delete statuses[o.path.id];
        } else statuses[o.path.id] = { type: "busy" };
        messages.set(o.path.id, rows);
        return { data: undefined };
      }),
      messages: vi.fn(async (o: any) => ({ data: messages.get(o.path.id) ?? [] })),
      status: vi.fn(async () => ({ data: { ...statuses } })),
      abort: vi.fn(async () => ({})),
      list: vi.fn(),
    },
  };
  const config = { gateway: { ...defaultGatewayConfig() } } as unknown as ResolvedConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mgr = createSessionManager({
    opencode: opencode as never,
    inkbox: inkbox as never,
    config,
    state,
    logger,
    directory: "/proj",
  });
  return {
    mgr,
    opencode,
    identity,
    state,
    dir,
    messages,
    statuses,
    setReply(value: string) {
      reply = value;
    },
    setAutoComplete(value: boolean) {
      autoComplete = value;
    },
  };
}

function sms(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "sms",
    chatKey: "ck",
    from: "+15551112222",
    conversationId: "conv-1",
    text,
    mediaPaths: [],
    ...over,
  };
}

function prepareHostedCall(dir: string): void {
  process.env.INKBOX_OPENCODE_HOME = dir;
  saveHostedCall({
    identityId: "ident-1",
    callId: "call-1",
    eventId: "evt-1",
    state: "running",
    event: {
      id: "evt-1",
      event_type: "call.ended",
      timestamp: "2026-08-01T00:00:00Z",
      data: { call: { id: "call-1", mode: "hosted_agent" } },
    } as any,
  });
}

describe("durable async turns", () => {
  it("creates a session once and uses promptAsync with a stable message id", async () => {
    const d = makeManager();
    await d.mgr.handleInbound(sms("first"));
    await d.mgr.handleInbound(sms("second"));

    expect(d.opencode.session.create).toHaveBeenCalledTimes(1);
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    const first = d.opencode.session.promptAsync.mock.calls[0][0];
    expect(first.body.messageID).toMatch(/^msg_[a-f0-9]{32}$/);
    expect(first.body.parts[0].text).toContain("first");
    expect(d.state.getTurn(first.body.messageID)?.state).toBe("delivered");
  });

  it("drops a stale persisted session before submission", async () => {
    const d = makeManager();
    d.state.setSession("ck", "stale");
    d.opencode.session.get.mockResolvedValueOnce({ error: { name: "NotFound" } } as any);

    await d.mgr.handleInbound(sms("hello"));

    expect(d.state.getSession("ck")).toBe("sess-1");
    expect(d.opencode.session.promptAsync.mock.calls[0][0].path.id).toBe("sess-1");
  });

  it("does not replay an ambiguous submission in a fresh session", async () => {
    const d = makeManager();
    d.opencode.session.promptAsync.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(d.mgr.handleInbound(sms("once"))).rejects.toThrow("fetch failed");

    expect(d.opencode.session.create).toHaveBeenCalledTimes(1);
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(d.state.listTurns()[0].state).toBe("failed");
  });

  it("reconciles a transport error when OpenCode accepted the message", async () => {
    const d = makeManager();
    d.opencode.session.promptAsync.mockImplementationOnce(async (o: any) => {
      d.messages.set(o.path.id, [
        { info: { id: o.body.messageID, role: "user" }, parts: o.body.parts },
        {
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: o.body.messageID,
            time: { completed: Date.now() },
            finish: "stop",
          },
          parts: [{ type: "text", text: "accepted" }],
        },
      ]);
      throw new TypeError("fetch failed");
    });

    await d.mgr.handleInbound(sms("once"));

    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect((d.identity.sendText.mock.calls as any)[0][0].text).toBe("accepted");
  });

  it("delivers the completed assistant response", async () => {
    const d = makeManager();
    d.setReply("hello");

    await d.mgr.handleInbound(sms("ping"));

    expect(d.identity.sendText).toHaveBeenCalledOnce();
    expect((d.identity.sendText.mock.calls as any)[0][0].text).toBe("hello");
    expect(d.state.getReplyTarget("ck")?.conversationId).toBe("conv-1");
  });

  it("resumes a submitted normal turn after restart without resubmitting", async () => {
    const d = makeManager();
    const now = Date.now();
    const turn: DurableTurn = {
      id: "msg_recover",
      messageID: "msg_recover",
      chatKey: "ck",
      sessionID: "sess-old",
      state: "submitted",
      kind: "normal",
      text: "recover",
      deliver: true,
      replyTarget: { channel: "sms", to: "+15551112222" },
      createdAt: now,
      updatedAt: now,
    };
    d.state.saveTurn(turn);
    d.messages.set("sess-old", [
      { info: { id: turn.messageID, role: "user" }, parts: [] },
      {
        info: {
          id: "assistant-old",
          role: "assistant",
          parentID: turn.messageID,
          time: { completed: now },
          finish: "stop",
        },
        parts: [{ type: "text", text: "recovered" }],
      },
    ]);

    await d.mgr.catchUp();
    await vi.waitFor(() => expect(d.state.getTurn(turn.id)?.state).toBe("delivered"));

    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    expect(d.identity.sendText).toHaveBeenCalledOnce();
  });

  it("submits a durable queued turn after restart", async () => {
    const d = makeManager();
    const now = Date.now();
    d.state.saveTurn({
      id: "msg_queued",
      messageID: "msg_queued",
      chatKey: "ck",
      state: "queued",
      kind: "normal",
      text: "queued",
      deliver: false,
      createdAt: now,
      updatedAt: now,
    });

    await d.mgr.catchUp();
    await vi.waitFor(() => expect(d.state.getTurn("msg_queued")?.state).toBe("completed"));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
  });

  it("does not repeat an ambiguous reply delivery after restart", async () => {
    const d = makeManager();
    const now = Date.now();
    d.state.saveTurn({
      id: "msg_delivery",
      messageID: "msg_delivery",
      chatKey: "ck",
      sessionID: "sess-old",
      state: "delivery_started",
      kind: "normal",
      text: "hello",
      output: "reply",
      deliver: true,
      replyTarget: { channel: "sms", to: "+15551112222" },
      createdAt: now,
      updatedAt: now,
    });

    await d.mgr.catchUp();

    expect(d.state.getTurn("msg_delivery")?.state).toBe("failed");
    expect(d.identity.sendText).not.toHaveBeenCalled();
  });

  it("continues the queue after interrupting a running turn", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    const first = d.mgr.handleInbound(sms("first"));
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());
    d.setAutoComplete(true);

    const second = d.mgr.handleInbound(sms("second"));

    await expect(first).resolves.toBeUndefined();
    await second;
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(d.identity.sendText).toHaveBeenCalledOnce();
  });

  it("does not resurrect a turn interrupted during prompt submission", async () => {
    const d = makeManager();
    let release: (value: { data: undefined }) => void = () => {};
    d.opencode.session.promptAsync.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const first = d.mgr.handleInbound(sms("first"));
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());
    const second = d.mgr.handleInbound(sms("second"));

    release({ data: undefined });

    await expect(first).resolves.toBeUndefined();
    await second;
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(d.identity.sendText).toHaveBeenCalledOnce();
  });

  it("does not submit a turn interrupted during session validation", async () => {
    const d = makeManager();
    d.state.setSession("ck", "sess-existing");
    let release: (value: { data: { id: string; directory: string } }) => void = () => {};
    d.opencode.session.get.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const first = d.mgr.handleInbound(sms("first"));
    await vi.waitFor(() => expect(d.opencode.session.get).toHaveBeenCalledOnce());

    const second = d.mgr.handleInbound(sms("second"));
    release({ data: { id: "sess-existing", directory: "/proj" } });

    await expect(first).resolves.toBeUndefined();
    await second;
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    expect(d.identity.sendText).toHaveBeenCalledOnce();
  });

  it("interrupts a normal turn owned by another gateway", async () => {
    const firstGateway = makeManager();
    firstGateway.setAutoComplete(false);
    const first = firstGateway.mgr.handleInbound(sms("first"));
    await vi.waitFor(() =>
      expect(firstGateway.opencode.session.promptAsync).toHaveBeenCalledOnce(),
    );

    const secondGateway = makeManager(firstGateway.dir);
    const second = secondGateway.mgr.handleInbound(sms("second"));

    await expect(first).resolves.toBeUndefined();
    await second;
    expect(firstGateway.identity.sendText).not.toHaveBeenCalled();
    expect(secondGateway.identity.sendText).toHaveBeenCalledOnce();
    expect(firstGateway.state.listTurns().find((turn) => turn.text.includes("first"))?.state).toBe(
      "interrupted",
    );
  });

  it("retries after a transient state lock failure without wedging the queue", async () => {
    const d = makeManager();
    const claimTurn = d.state.claimTurn.bind(d.state);
    vi.spyOn(d.state, "claimTurn")
      .mockImplementationOnce(() => {
        throw new Error("Gateway state is busy; retry this operation.");
      })
      .mockImplementation(claimTurn);

    await d.mgr.handleInbound(sms("first"));
    await d.mgr.handleInbound(sms("second"));

    expect(d.identity.sendText).toHaveBeenCalledTimes(2);
    expect(d.state.listTurns().every((turn) => turn.state === "delivered")).toBe(true);
  });
});

describe("capture turns", () => {
  it("returns text without channel delivery", async () => {
    const d = makeManager();
    d.setReply("captured");
    await expect(d.mgr.runCapture("ck", "event")).resolves.toBe("captured");
    expect(d.identity.sendText).not.toHaveBeenCalled();
  });

  it("keeps hosted initial delegation disabled", async () => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    await d.mgr.runHostedCapture?.("ck", "call", {
      identityId: "ident-1",
      callId: "call-1",
      phase: "initial",
      expectedTarget: "+14155550123",
    });
    expect(d.opencode.session.promptAsync.mock.calls[0][0].body.tools).toMatchObject({
      task: false,
      inkbox_a2a_call: false,
    });
  });

  it("reattaches to a completed hosted turn", async () => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    const capture = {
      identityId: "ident-1",
      callId: "call-1",
      phase: "initial" as const,
      expectedTarget: "+14155550123",
    };
    await d.mgr.runHostedCapture?.("ck", "call", capture);
    const submitted = d.opencode.session.promptAsync.mock.calls.length;
    await d.mgr.runHostedCapture?.("ck", "call", capture);
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(submitted);
  });

  it("restores the hosted SMS guard before monitoring a submitted turn", async () => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    d.setAutoComplete(false);
    const now = Date.now();
    const capture = {
      identityId: "ident-1",
      callId: "call-1",
      phase: "initial" as const,
      expectedTarget: "+14155550123",
    };
    d.state.saveTurn({
      id: "msg_hosted",
      messageID: "msg_hosted",
      chatKey: "ck",
      sessionID: "sess-old",
      state: "submitted",
      kind: "capture",
      text: "call",
      deliver: false,
      hostedCapture: capture,
      createdAt: now,
      updatedAt: now,
    });
    d.messages.set("sess-old", [{ info: { id: "msg_hosted", role: "user" }, parts: [] }]);
    d.statuses["sess-old"] = { type: "busy" };

    const pending = d.mgr.runHostedCapture?.("ck", "call", capture);
    await vi.waitFor(() =>
      expect(getHostedCall("ident-1", "call-1")?.active?.sessionID).toBe("sess-old"),
    );
    await d.mgr.close();
    await expect(pending).rejects.toThrow("deferred");
    expect(getHostedCall("ident-1", "call-1")?.active?.sessionID).toBe("sess-old");
  });

  it("reattaches A2A recovery to its durable turn", async () => {
    const d = makeManager();
    const context = {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
    };
    await d.mgr.runA2A("a2a:context-1", "task", context);
    const submitted = d.opencode.session.promptAsync.mock.calls.length;

    await d.mgr.runA2A("a2a:context-1", "task", context);

    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(submitted);
  });
});

describe("control", () => {
  it("aborts a durable running turn", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    const running = d.mgr.handleInbound(sms("long"));
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());

    await expect(d.mgr.abortTurn("ck")).resolves.toBe(true);
    expect(d.opencode.session.abort).toHaveBeenCalledOnce();
    await expect(running).resolves.toBeUndefined();
  });

  it("reports durable busy state", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    const running = d.mgr.handleInbound(sms("long"));
    await vi.waitFor(() => expect(d.mgr.status("ck").busy).toBe(true));
    await d.mgr.abortTurn("ck");
    await running;
  });

  it("settles a canceled queued A2A turn", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    const blocking = d.mgr.runText("ck", "blocking");
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());
    const pending = d.mgr.runA2A("ck", "task", {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
    });

    await expect(d.mgr.abortA2A("ck", "task-1")).resolves.toBe(true);
    await expect(pending).resolves.toBeUndefined();
    await d.mgr.abortTurn("ck");
    await blocking;
  });
});

describe("extractText", () => {
  it("joins text parts", () => {
    expect(
      extractText({
        parts: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("Hello world");
  });

  it("ignores empty and non-text parts", () => {
    expect(extractText({ data: { parts: [{ type: "tool" }] } })).toBeUndefined();
    expect(extractText(undefined)).toBeUndefined();
  });
});
