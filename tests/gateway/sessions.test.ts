import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { defaultGatewayConfig } from "../../src/config.js";
import {
  COMPANION_MAX_BYTES,
  type CompanionTurn,
  companionChatKey,
} from "../../src/gateway/companion.js";
import { createNotifyOnce } from "../../src/gateway/dedup.js";
import { dispatchEvent } from "../../src/gateway/dispatch.js";
import {
  beginHostedSmsAttempt,
  getHostedCall,
  saveHostedCall,
  settleHostedSmsAttempt,
} from "../../src/gateway/hosted-call-registry.js";
import { createSessionManager, extractText } from "../../src/gateway/sessions.js";
import { createStateStore, type DurableTurn } from "../../src/gateway/state.js";
import type { InboundMessage } from "../../src/gateway/types.js";
import fixture from "../fixtures/companion-v1.json" with { type: "json" };

const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INKBOX_OPENCODE_HOME;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeIdentity() {
  return {
    id: "identity-1",
    agentHandle: "test-agent",
    emailAddress: "test-agent@inkboxmail.com",
    phoneNumber: { number: "+15559990000" },
    imessageEnabled: true,
    sendEmail: vi.fn(async () => ({ id: "email-1" })),
    replyAllEmail: vi.fn(async (_id: string, _opts: unknown) => ({ id: "email-1" })),
    getMessage: vi.fn(async () => ({
      id: "parent-1",
      threadId: "conversation-1",
      messageId: "<parent@example.com>",
      replyAllRecipients: {
        to: ["sponsor@example.com"],
        cc: ["fred@example.com", "nancy@example.com"],
      },
    })),
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
        data: [
          "bash",
          "edit",
          "task",
          "inkbox_send_sms",
          "inkbox_send_email",
          "inkbox_a2a_call",
          "inkbox_list_a2a_tasks",
          "inkbox_list_a2a_messages",
        ],
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
      prompt: vi.fn(async (_o: any) => ({
        data: {
          info: { id: "progress-response", role: "assistant" },
          parts: [{ type: "text", text: "I'm validating the requested work." }],
        },
      })),
      messages: vi.fn(async (o: any) => ({ data: messages.get(o.path.id) ?? [] })),
      status: vi.fn(async () => ({ data: { ...statuses } })),
      abort: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({ data: true })),
      list: vi.fn(),
    },
  };
  const config = { gateway: { ...defaultGatewayConfig() } } as unknown as ResolvedConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const companionSenderAllowed = vi.fn(async (from: string) => from === "sponsor@example.com");
  const companionLocalAllowed = vi.fn(
    (_from: string, _contactId: string | undefined, _requireReply: boolean) => true,
  );
  const companionControl = vi.fn(
    async (_turn: CompanionTurn, _key: string, _target: unknown) => false,
  );
  const mgr = createSessionManager({
    opencode: opencode as never,
    inkbox: inkbox as never,
    config,
    state,
    logger,
    directory: "/proj",
    companionSenderAllowed,
    companionLocalAllowed,
    companionControl,
  });
  return {
    mgr,
    inkbox,
    companionSenderAllowed,
    companionLocalAllowed,
    companionControl,
    config,
    logger,
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
    const second = d.opencode.session.promptAsync.mock.calls[1][0];
    expect(first.body.messageID).toMatch(/^msg_[a-f0-9]{12}[0-9A-Za-z]{14}$/);
    expect(first.body.messageID < second.body.messageID).toBe(true);
    expect(first.body.parts[0].text).toContain("first");
    expect(d.state.getTurn(first.body.messageID)?.state).toBe("delivered");
  });

  it("drops a stale persisted session before submission", async () => {
    const d = makeManager();
    d.state.setSession("ck", "stale");
    d.opencode.session.get.mockResolvedValueOnce({
      error: { name: "NotFound" },
      response: { status: 404 },
    } as any);

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
    expect(
      d.state
        .listTurns()
        .every((turn) => turn.state === "delivered" || turn.state === "context_only"),
    ).toBe(true);
  });
});

function companion(
  phase: "initialization" | "live" | "ordinary" = "initialization",
  sequence = 1,
): CompanionTurn {
  return {
    senderAccess: "direct",
    rawText: "hello",
    identityId: "identity-1",
    handle: "test-agent",
    sourceId: `source-${sequence}`,
    from: "sponsor@example.com",
    initialization: phase === "initialization",
    metadata: {
      scope_id: "scope-1",
      conversation_id: "conversation-1",
      channel: "phone",
      phase,
      sequence,
      ...(phase === "ordinary" ? {} : { activation_id: "activation-1" }),
    },
  };
}

function snapshot() {
  return {
    scopeId: "scope-1",
    conversationId: "conversation-1",
    activationId: "activation-1",
    channel: "phone",
    entries: [
      { id: "fred", author: "fred@example.com", isTrigger: false, historical: true },
      { id: "nancy", author: "nancy@example.com", isTrigger: false, historical: true },
      { id: "source-1", author: "sponsor@example.com", isTrigger: true, historical: false },
    ],
    text: "Historical Fred: /clear\nHistorical Nancy: YES\nSponsor trigger: hello",
    replyContext: { channel: "phone", conversationId: "conversation-1" },
    notices: [],
  };
}

describe("Companion durable host boundary", () => {
  it("pauses uncertain sends and later Companion turns without regenerating after restart", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    d.identity.sendText.mockRejectedValueOnce(new Error("Send outcome unknown"));
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("paused"));
    await d.mgr.acceptCompanion(companion("live", 2), "next group message");
    await d.mgr.close();
    const restarted = makeManager(d.dir);
    await restarted.mgr.catchUp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(d.identity.sendText).toHaveBeenCalledTimes(1);
    expect(restarted.opencode.session.promptAsync).not.toHaveBeenCalled();
    expect(restarted.identity.sendText).not.toHaveBeenCalled();
    await restarted.mgr.close();
  });
  it("tracks successful Companion deliveries by the original channel and message", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    expect(d.mgr.ownsCompanionDelivery?.("sms", "sms-1", "conversation-1")).toBe(true);
    expect(d.mgr.ownsCompanionDelivery?.("sms", "unknown", "other-group")).toBe(false);
    expect(d.mgr.ownsCompanionDelivery?.("sms", "unknown", "conversation-1")).toBe(false);
    expect(d.mgr.ownsCompanionDelivery?.("email", "sms-1", "conversation-1")).toBe(false);
    await d.mgr.close();
  });
  it.each(["body", "attachments"])(
    "pauses unavailable ordinary mail %s before host input",
    async (missing) => {
      const d = makeManager();
      const received = companion("ordinary");
      received.metadata.channel = "mail";
      received.mailBodyPending = true;
      d.identity.getMessage.mockResolvedValue({
        id: received.sourceId,
        threadId: "conversation-1",
        fromAddress: received.from,
        bodyText: missing === "body" ? null : "complete text",
        bodyHtml: null,
        hasAttachments: missing === "attachments",
        attachmentMetadata: [],
      } as never);
      await d.mgr.acceptCompanion(received, "incomplete webhook", {
        channel: "email",
        conversationId: "conversation-1",
        companion: {
          replyToMessageId: received.sourceId,
          to: [received.from, "fred@example.com"],
          cc: [],
        },
      });
      await vi.waitFor(() => expect(d.state.listTurns()[0].retryAt).toBeGreaterThan(0));
      expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
      await d.mgr.close();
    },
  );
  it("fences a hydration worker after another owner takes its lease", async () => {
    const d = makeManager();
    let release!: () => void;
    const loadInitialization = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return snapshot();
    });
    d.inkbox.getClient.mockResolvedValue({ companion: { loadInitialization } });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(loadInitialization).toHaveBeenCalledTimes(1));
    const turn = d.state.listTurns()[0];
    d.state.updateTurn(turn.id, { ownerId: "replacement", leaseUntil: Date.now() + 60000 });
    release();
    await vi.waitFor(() => expect(d.logger.error).toHaveBeenCalled());
    expect(d.state.getTurn(turn.id)?.ownerId).toBe("replacement");
    expect(d.state.getTurn(turn.id)?.state).toBe("hydrating");
    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    await d.mgr.close();
  });
  it("does not dispatch a live source already included in initialization", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: {
        loadInitialization: vi.fn(async () => snapshot()),
        activationMessages: vi.fn(async () => snapshot()),
      },
    });
    const live = companion("live", 2);
    live.sourceId = "source-1";
    await d.mgr.acceptCompanion(live, "duplicate trigger");
    await vi.waitFor(() =>
      expect(
        d.state
          .listTurns()
          .every((turn) => turn.state === "delivered" || turn.state === "context_only"),
      ).toBe(true),
    );
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    await d.mgr.close();
  });
  it("hydrates a truncated live email with attachments into one later input", async () => {
    const d = makeManager();
    d.setReply("[SILENT]");
    const loaded = {
      ...snapshot(),
      channel: "mail",
      replyContext: {
        channel: "mail",
        conversationId: "conversation-1",
        replyToMessageId: "source-1",
        to: ["sponsor@example.com", "fred@example.com"],
        cc: [],
      },
    };
    d.inkbox.getClient.mockResolvedValue({
      companion: {
        loadInitialization: vi.fn(async () => loaded),
        activationMessages: vi.fn(async () => loaded),
      },
    });
    const first = companion();
    first.metadata.channel = "mail";
    await d.mgr.acceptCompanion(first, "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    const live = companion("live", 2);
    live.metadata.channel = "mail";
    live.from = "fred@example.com";
    live.mailBodyPending = true;
    d.identity.getMessage.mockResolvedValue({
      id: "source-2",
      threadId: "conversation-1",
      fromAddress: live.from,
      bodyText: "complete live body",
      bodyHtml: null,
      attachmentMetadata: [{ index: 0, content_type: "text/plain" }],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    } as never);
    await d.mgr.acceptCompanion(live, "truncated prefix");
    await vi.waitFor(() =>
      expect(
        d.state
          .listTurns()
          .every((turn) => turn.state === "delivered" || turn.state === "context_only"),
      ).toBe(true),
    );
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    const text = d.opencode.session.promptAsync.mock.calls[1][0].body.parts[0].text;
    expect(text).toContain("complete live body");
    expect(text).toContain("text/plain");
    expect(text).not.toContain("truncated prefix");
    await d.mgr.close();
  });
  it("does not perform a second authorization read after host session creation", async () => {
    const d = makeManager();
    let revoked = false;
    d.opencode.session.create.mockImplementationOnce(async () => {
      revoked = true;
      return { data: { id: "sess-1" } };
    });
    d.inkbox.getClient.mockResolvedValue({
      companion: {
        loadInitialization: vi.fn(async () => snapshot()),
        activationMessages: vi.fn(async () => {
          if (revoked) throw new Error("activation revoked");
          return snapshot();
        }),
      },
    });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    expect(d.opencode.session.create).toHaveBeenCalledTimes(1);
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    await d.mgr.close();
  });
  it.each(["mail", "phone", "imessage"] as const)(
    "exhausts real SDK v1 pages into exactly one %s promptAsync input",
    async (channel) => {
      const d = makeManager();
      d.setReply("[SILENT]");
      expect(fixture.version).toBe(1);
      const pages = structuredClone(fixture.pages).map((page) => ({
        ...page,
        channel,
        reply_context: { ...page.reply_context, channel },
      }));
      const first = pages[0];
      if (channel !== "mail")
        for (const page of pages)
          for (const entry of page.items) {
            if (entry.is_trigger) entry.author = "+15551110000";
          }
      if (channel !== "mail")
        d.companionSenderAllowed.mockImplementation(async (from) => from === "+15551110000");
      const c = companion();
      c.metadata = {
        ...c.metadata,
        channel,
        scope_id: first.scope_id,
        activation_id: first.activation_id,
        conversation_id: first.conversation_id,
      };
      c.sourceId = pages[1].items[1].id;
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const last = new URL(String(input)).searchParams.has("cursor");
        return new Response(JSON.stringify(pages[last ? 1 : 0]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetch);
      d.inkbox.getClient.mockResolvedValue(
        new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://api.example.com" }),
      );
      const received = {
        provider: "inkbox",
        verified: true,
        headers: {},
        eventType:
          channel === "mail"
            ? "message.received"
            : channel === "phone"
              ? "text.received"
              : "imessage.received",
        body: {
          companion: c.metadata,
          data: {
            [channel === "phone" ? "text_message" : "message"]: {
              sender_access: "direct",
              id: c.sourceId,
              thread_id: c.metadata.conversation_id,
              conversation_id: c.metadata.conversation_id,
              from_address: "sponsor@example.com",
              sender_phone_number: "+15551110000",
              sender_number: "+15551110000",
              remote_number: null,
              body: "trigger only must not be used",
              text: "trigger only must not be used",
              content: "trigger only must not be used",
            },
          },
        },
      };
      const contacts = { resolve: vi.fn(), chatKeyFor: vi.fn() };
      const handleInbound = vi.fn(async () => {});
      const deps = {
        inkbox: d.inkbox as never,
        config: d.config,
        logger: d.logger,
        sessions: { ...d.mgr, handleInbound },
        contacts,
        notify: createNotifyOnce(),
      };
      await dispatchEvent(deps, received);
      await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
      const text = d.opencode.session.promptAsync.mock.calls[0][0].body.parts[0].text;
      const entries = [first.items[0], first.items[1], pages[1].items[1]];
      for (const entry of entries) expect(text.split(`"id":"${entry.id}"`)).toHaveLength(2);
      expect(text.indexOf(`"id":"${entries[0].id}"`)).toBeLessThan(
        text.indexOf(`"id":"${entries[1].id}"`),
      );
      expect(text.indexOf(`"id":"${entries[1].id}"`)).toBeLessThan(
        text.indexOf(`"id":"${entries[2].id}"`),
      );
      expect(text).toContain("source_message_id");
      expect(text).toContain("future_history_notice");
      expect(text).toContain("café.");
      expect(d.opencode.session.abort).not.toHaveBeenCalled();
      expect(handleInbound).not.toHaveBeenCalled();
      expect(contacts.resolve).not.toHaveBeenCalled();
      await dispatchEvent(deps, received);
      expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
      await d.mgr.close();
    },
  );
  it.each(["mail", "phone", "imessage"] as const)(
    "submits one %s initialization and retains its immutable group reply",
    async (channel) => {
      const d = makeManager();
      const c = companion();
      c.metadata.channel = channel;
      const loaded = {
        ...snapshot(),
        channel,
        replyContext: {
          channel,
          conversationId: "conversation-1",
          replyToMessageId: "source-1",
          to: ["sponsor@example.com"],
          cc: ["fred@example.com", "nancy@example.com"],
        },
      };
      d.inkbox.getClient.mockResolvedValue({
        companion: {
          loadInitialization: vi.fn(async () => loaded),
          activationMessages: vi.fn(async () => loaded),
        },
      });
      await d.mgr.acceptCompanion(c, "trigger");
      await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
      expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
      expect(d.opencode.session.promptAsync.mock.calls[0][0].body.parts).toHaveLength(1);
      if (channel === "mail") {
        expect(d.identity.getMessage).not.toHaveBeenCalled();
        expect(d.identity.sendEmail).not.toHaveBeenCalled();
        expect(d.identity.replyAllEmail).toHaveBeenCalledWith("source-1", { bodyText: "reply" });
      } else
        expect(
          channel === "phone" ? d.identity.sendText : d.identity.sendIMessage,
        ).toHaveBeenCalledWith({ conversationId: "conversation-1", text: "reply" });
      await d.mgr.close();
    },
  );
  it("persists before hydration, submits one initializer, and orders live followups without interrupting", async () => {
    const d = makeManager();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadInitialization = vi.fn(async () => {
      await barrier;
      return snapshot();
    });
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization, activationMessages: vi.fn(async () => snapshot()) },
    });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await d.mgr.acceptCompanion(companion("live", 2), "sponsor followup");
    await d.mgr.acceptCompanion(companion(), "duplicate");
    expect(d.state.listTurns()).toHaveLength(2);
    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(
        d.state
          .listTurns()
          .every((turn) => turn.state === "delivered" || turn.state === "context_only"),
      ).toBe(true),
    );
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    const calls = d.opencode.session.promptAsync.mock.calls;
    expect(calls[0][0].body.parts[0].text).toContain(snapshot().text);
    expect(calls[1][0].body.parts[0].text).toContain("sponsor followup");
    expect(d.opencode.session.abort).not.toHaveBeenCalled();
    expect(d.identity.sendText.mock.calls).toEqual([
      [{ text: "reply", conversationId: "conversation-1" }],
      [{ text: "reply", conversationId: "conversation-1" }],
    ]);
    await d.mgr.acceptCompanion(companion(), "duplicate after completion");
    await d.mgr.catchUp();
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    await d.mgr.close();
  });

  it("recovers pending hydration with the same host message ID", async () => {
    const d = makeManager();
    const c = companion();
    const chatKey = companionChatKey(c.identityId, c.metadata);
    d.state.saveTurn({
      id: `${chatKey}:initialization`,
      messageID: "msg_saved",
      chatKey,
      state: "hydrating",
      kind: "capture",
      text: "",
      deliver: true,
      companion: c,
      createdAt: 1,
      updatedAt: 1,
    });
    d.inkbox.getClient.mockResolvedValue({
      companion: {
        loadInitialization: vi.fn(async () => snapshot()),
        activationMessages: vi.fn(async () => snapshot()),
      },
    });
    await d.mgr.catchUp();
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(d.opencode.session.promptAsync.mock.calls[0][0].body.messageID).toBe("msg_saved");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    await d.mgr.close();
  });

  it("pauses an uncertain accepted turn and its live queue across restart", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: {
        loadInitialization: vi.fn(async () => snapshot()),
        activationMessages: vi.fn(async () => snapshot()),
      },
    });
    d.opencode.session.promptAsync.mockRejectedValueOnce(new Error("outcome unknown"));
    await d.mgr.acceptCompanion(companion(), "trigger");
    await d.mgr.acceptCompanion(companion("live", 2), "followup");
    await vi.waitFor(() =>
      expect(d.state.listTurns().some((turn) => turn.state === "paused")).toBe(true),
    );
    await d.mgr.close();
    const restarted = makeManager(d.dir);
    await restarted.mgr.catchUp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(restarted.opencode.session.promptAsync).not.toHaveBeenCalled();
    await restarted.mgr.close();
  });

  it.each(["oversize", "revoked", "sponsor denied", "wrong scope"])(
    "pauses %s before any host input",
    async (failure) => {
      const d = makeManager();
      const loaded = snapshot();
      if (failure === "oversize") loaded.text = "x".repeat(COMPANION_MAX_BYTES);
      if (failure === "wrong scope") loaded.scopeId = "other";
      if (failure === "sponsor denied") d.companionSenderAllowed.mockResolvedValue(false);
      d.inkbox.getClient.mockResolvedValue({
        companion: {
          loadInitialization: vi.fn(async () => {
            if (failure === "revoked") throw new Error("activation unavailable");
            return loaded;
          }),
        },
      });
      await d.mgr.acceptCompanion(companion(), "trigger");
      await vi.waitFor(() => expect(d.state.listTurns()[0].retryAt).toBeGreaterThan(0));
      expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
      await d.mgr.close();
    },
  );

  it("keeps ordinary, new cohorts and private contact sessions separate", async () => {
    const d = makeManager();
    const loadInitialization = vi.fn(async (_handle: string, activation: string) => ({
      ...snapshot(),
      activationId: activation,
    }));
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization, activationMessages: loadInitialization },
    });
    await d.mgr.acceptCompanion(companion("ordinary"), "normal sponsor message", {
      channel: "sms",
      conversationId: "conversation-1",
    });
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1));
    expect(loadInitialization).not.toHaveBeenCalled();
    await d.mgr.acceptCompanion(companion(), "trigger");
    const next = companion();
    next.metadata.activation_id = "activation-2";
    await d.mgr.acceptCompanion(next, "new cohort trigger");
    await d.mgr.handleInbound(sms("private", { chatKey: "contact:sponsor" }));
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(4));
    expect(
      new Set(d.opencode.session.promptAsync.mock.calls.map(([input]) => input.path.id)).size,
    ).toBe(4);
    await d.mgr.close();
  });
});

describe("capture turns", () => {
  it("returns text without channel delivery", async () => {
    const d = makeManager();
    d.setReply("captured");
    await expect(d.mgr.runCapture("ck", "event")).resolves.toBe("captured");
    expect(d.identity.sendText).not.toHaveBeenCalled();
  });

  it("limits hosted initial work to non-A2A Inkbox tools", async () => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    await d.mgr.runHostedCapture?.("ck", "call", {
      identityId: "ident-1",
      callId: "call-1",
      phase: "initial",
      expectedTarget: "+14155550123",
    });
    expect(d.opencode.session.promptAsync.mock.calls[0][0].body.tools).toEqual({
      bash: false,
      edit: false,
      task: false,
      inkbox_send_sms: true,
      inkbox_send_email: true,
      inkbox_a2a_call: false,
      inkbox_list_a2a_tasks: false,
      inkbox_list_a2a_messages: false,
    });
  });

  it("limits a hosted correction to the SMS tool", async () => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    await d.mgr.runHostedCapture?.("ck", "call", {
      identityId: "ident-1",
      callId: "call-1",
      phase: "correction",
      expectedTarget: "+14155550123",
    });
    expect(d.opencode.session.promptAsync.mock.calls[0][0].body.tools).toEqual({
      bash: false,
      edit: false,
      task: false,
      inkbox_send_sms: true,
      inkbox_send_email: false,
      inkbox_a2a_call: false,
      inkbox_list_a2a_tasks: false,
      inkbox_list_a2a_messages: false,
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

  it.each([
    { status: "retry", finish: "stop" },
    { status: "idle", finish: "tool-calls" },
    { status: "idle", finish: "unknown" },
    { status: "idle", finish: undefined },
  ])("retains the hosted SMS guard during $status/$finish", async ({ status, finish }) => {
    const d = makeManager();
    prepareHostedCall(d.dir);
    d.opencode.session.status.mockImplementation(async () => ({
      data: { "sess-1": { type: status } },
    }));
    const originalPrompt = d.opencode.session.promptAsync.getMockImplementation();
    if (!originalPrompt) throw new Error("Missing prompt fixture");
    d.opencode.session.promptAsync.mockImplementation(async (args: any) => {
      const result = await originalPrompt(args);
      const last = d.messages.get("sess-1")?.at(-1);
      last.info.finish = finish;
      const guard = beginHostedSmsAttempt({
        sessionID: "sess-1",
        target: "+14155550123",
        hasConversationId: false,
      });
      expect(guard).toBeDefined();
      if (guard) settleHostedSmsAttempt(guard, "success", undefined, "sent-1");
      return result;
    });
    const pending = d.mgr.runHostedCapture?.("ck", "call", {
      identityId: "ident-1",
      callId: "call-1",
      phase: "initial",
      expectedTarget: "+14155550123",
    });
    try {
      await vi.waitFor(
        () => expect(d.opencode.session.status.mock.calls.length).toBeGreaterThan(1),
        {
          timeout: 2_000,
        },
      );
      expect(getHostedCall("ident-1", "call-1")?.active?.sessionID).toBe("sess-1");
      expect(() =>
        beginHostedSmsAttempt({
          sessionID: "sess-1",
          target: "+14155550123",
          hasConversationId: false,
        }),
      ).toThrow("second SMS attempt");
      d.opencode.session.status.mockResolvedValue({ data: {} });
      const last = d.messages.get("sess-1")?.at(-1);
      last.info.finish = "stop";
      await pending;
      expect(getHostedCall("ident-1", "call-1")?.active).toBeUndefined();
    } finally {
      await d.mgr.close();
      await pending?.catch(() => {});
    }
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

  it("builds A2A progress in an isolated tool-free side session", async () => {
    const d = makeManager();
    const context = {
      taskId: "task-1",
      messageId: "message-1",
      contextId: "context-1",
      replyIntentCommitted: false,
    };
    await d.mgr.runA2A("a2a:context-1", "private task body", context);
    const workerTurn = d.state.listTurns().find((turn) => turn.a2aContext?.taskId === "task-1");
    d.messages.set(workerTurn?.sessionID ?? "", [
      { info: { id: workerTurn?.messageID, role: "user" }, parts: [] },
      {
        info: { id: "assistant", role: "assistant", parentID: workerTurn?.messageID },
        parts: [
          {
            type: "tool",
            tool: "run_sql_query",
            state: { input: { query: "private-value" }, output: "private-result" },
          },
        ],
      },
    ]);

    await expect(
      d.mgr.summarizeA2AProgress?.("a2a:context-1", "task-1", "previous public update"),
    ).resolves.toBe("I'm validating the requested work.");

    const sidePrompt = d.opencode.session.prompt.mock.calls[0][0];
    expect(sidePrompt.body.parts[0].text).toContain("run_sql_query");
    expect(sidePrompt.body.parts[0].text).toContain("private task body");
    expect(JSON.stringify(sidePrompt)).not.toContain("private-value");
    expect(JSON.stringify(sidePrompt)).not.toContain("private-result");
    expect(Object.values(sidePrompt.body.tools).every((enabled) => enabled === false)).toBe(true);
    expect(d.opencode.session.delete).toHaveBeenCalledOnce();
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

describe("quiet context and startup recovery", () => {
  it("persists quiet group messages without opening or interrupting a host session", async () => {
    const d = makeManager();
    d.config.gateway.groupReplyMode = "mention";
    await d.mgr.handleInbound(sms("unaddressed history", { group: { participantCount: 2 } }));
    expect(d.opencode.session.create).not.toHaveBeenCalled();
    expect(d.opencode.session.abort).not.toHaveBeenCalled();
    expect(d.state.getReplyTarget("ck")).toBeUndefined();
    await d.mgr.close();
    const restarted = makeManager(d.dir);
    restarted.config.gateway.groupReplyMode = "mention";
    await restarted.mgr.handleInbound(sms("@agent answer", { group: { participantCount: 2 } }));
    expect(restarted.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    const prompt = restarted.opencode.session.promptAsync.mock.calls[0][0].body.parts[0].text;
    expect(prompt).toContain("unaddressed history");
    expect(prompt).toContain("@agent answer");
    await restarted.mgr.close();
  });
  it("does not wake a historical sponsor when a sponsored live receipt arrives first", async () => {
    const d = makeManager();
    const loadInitialization = vi.fn(async () => snapshot());
    d.inkbox.getClient.mockResolvedValue({ companion: { loadInitialization } });
    await d.mgr.acceptCompanion(
      { ...companion("live", 2), senderAccess: "sponsored", rawText: "@agent quiet" },
      "quiet live body",
    );
    await vi.waitFor(() =>
      expect(d.state.listTurns().filter((turn) => turn.state === "context_only")).toHaveLength(2),
    );
    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    await d.mgr.close();
    const restarted = makeManager(d.dir);
    await restarted.mgr.acceptCompanion(
      { ...companion("live", 3), rawText: "@agent help" },
      "current direct body",
    );
    await vi.waitFor(() => expect(restarted.identity.sendText).toHaveBeenCalledTimes(1));
    expect(restarted.inkbox.getClient).not.toHaveBeenCalled();
    const text = restarted.opencode.session.promptAsync.mock.calls[0][0].body.parts[0].text;
    expect(text).toContain(snapshot().text);
    expect(text).toContain("quiet live body");
    await restarted.mgr.close();
  });
  it("retries a transient resume error without losing the saved session", async () => {
    const d = makeManager();
    d.state.setSession("ck", "saved-session");
    d.opencode.session.get.mockRejectedValueOnce(new Error("temporary connection failure"));
    await d.mgr.handleInbound(sms("hello"));
    expect(d.opencode.session.create).not.toHaveBeenCalled();
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(d.opencode.session.promptAsync.mock.calls[0][0].path.id).toBe("saved-session");
    await d.mgr.close();
  });
  it("retries send preparation using the checkpointed answer, without generating twice", async () => {
    const d = makeManager();
    const prompt = d.opencode.session.promptAsync.getMockImplementation();
    if (!prompt) throw new Error("Missing host test implementation");
    d.opencode.session.promptAsync.mockImplementationOnce(async (input) => {
      const result = await prompt(input);
      d.inkbox.getIdentity.mockRejectedValueOnce(new Error("temporary identity failure"));
      return result;
    });
    await d.mgr.handleInbound(sms("hello"));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(d.identity.sendText).toHaveBeenCalledTimes(1);
    await d.mgr.close();
  });
});

describe("Companion recovery ordering and current-message controls", () => {
  it("hydrates a truncated email approval before the blocked host turn can finish", async () => {
    const d = makeManager();
    const received = companion("live", 2);
    received.metadata.channel = "mail";
    received.mailBodyPending = true;
    received.rawText = "";
    received.toAddresses = ["test-agent@inkboxmail.com"];
    received.emailAddress = "test-agent@inkboxmail.com";
    d.config.gateway.groupReplyMode = "mention";
    const chatKey = companionChatKey(received.identityId, received.metadata);
    d.state.saveTurn({
      id: `${chatKey}:history`,
      messageID: "history",
      chatKey,
      kind: "capture",
      state: "context_only",
      text: "history",
      deliver: false,
      consumedBy: "active",
      historyTriggerId: "source-1",
      companion: {
        ...companion(),
        metadata: { ...received.metadata, phase: "initialization", sequence: 1 },
      },
      replyTarget: {
        channel: "email",
        companionSponsor: received.from,
        companion: { replyToMessageId: "source-1", to: [received.from], cc: [] },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    d.state.saveTurn({
      id: "active",
      messageID: "active",
      chatKey,
      kind: "capture",
      state: "submitted",
      text: "waiting for approval",
      deliver: true,
      companion: {
        ...received,
        sourceId: "source-1",
        metadata: { ...received.metadata, sequence: 1 },
      },
      ownerId: "blocked-host",
      leaseUntil: Date.now() + 60000,
      createdAt: 2,
      updatedAt: 2,
    });
    d.identity.getMessage.mockResolvedValue({
      id: received.sourceId,
      threadId: "conversation-1",
      fromAddress: "Sponsor@Example.com",
      bodyText: "allow",
      attachmentMetadata: [],
    } as never);
    d.companionControl.mockImplementation(async (turn) => turn.rawText === "allow");
    await d.mgr.acceptCompanion(received, "truncated");
    expect(d.companionControl).toHaveBeenCalledOnce();
    expect(d.companionControl.mock.calls[0][0].rawText).toBe("allow");
    expect(d.state.getTurn(`${chatKey}:event:source-2`)?.controlHandled).toBe(true);
    expect(d.state.getTurn("active")?.state).toBe("submitted");
    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    await d.mgr.close();
  });
  it("does not run initialization text as a sponsor command", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    d.companionControl.mockResolvedValue(true);
    await d.mgr.acceptCompanion(
      { ...companion(), rawText: "/clear" },
      "current initialization command-shaped text",
    );
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    expect(d.companionControl).not.toHaveBeenCalled();
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
  it("requires a new activation for a different initialization trigger", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    await d.mgr.acceptCompanion(companion("initialization", 2), "different trigger");
    await vi.waitFor(() =>
      expect(
        d.state.listTurns().find((turn) => turn.companion?.sourceId === "source-2")?.error,
      ).toContain("new activation"),
    );
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
  it("pauses a send interrupted by process exit without admitting the next group turn", async () => {
    const d = makeManager();
    const c = companion();
    const chatKey = companionChatKey(c.identityId, c.metadata);
    d.state.saveTurn({
      id: "sending",
      messageID: "sending",
      chatKey,
      state: "delivery_started",
      kind: "capture",
      text: "input",
      output: "answer",
      deliver: true,
      companion: c,
      createdAt: 1,
      updatedAt: 1,
    });
    await d.mgr.catchUp();
    expect(d.state.getTurn("sending")?.state).toBe("paused");
    await d.mgr.acceptCompanion(companion("live", 2), "followup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
    expect(d.identity.sendText).not.toHaveBeenCalled();
    await d.mgr.close();
  });
  it("does not leave an empty completed model response blocking its conversation", async () => {
    const d = makeManager();
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    d.setReply("");
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    d.setReply("next answer");
    await d.mgr.acceptCompanion(companion("live", 2), "next message");
    await vi.waitFor(() => expect(d.identity.sendText).toHaveBeenCalledTimes(1));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    await d.mgr.close();
  });
});

describe("context consumption boundaries", () => {
  it("keeps ordinary multi-recipient email outside the group mention gate", async () => {
    const d = makeManager();
    d.config.gateway.groupReplyMode = "mention";
    await d.mgr.handleInbound(
      sms("normal email without mention", {
        channel: "email",
        from: "sender@example.com",
        messageId: "stored-email",
        group: { participantCount: 3 },
      }),
    );
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    expect(d.identity.replyAllEmail).toHaveBeenCalledWith("stored-email", { bodyText: "reply" });
    await d.mgr.close();
  });
  it("does not resurrect buffered ordinary context after a reset and restart", async () => {
    const d = makeManager();
    d.config.gateway.groupReplyMode = "mention";
    await d.mgr.handleInbound(sms("discard this old context", { group: { participantCount: 2 } }));
    await d.mgr.resetSession("ck");
    await d.mgr.close();
    const restarted = makeManager(d.dir);
    restarted.config.gateway.groupReplyMode = "mention";
    await restarted.mgr.handleInbound(sms("@agent current", { group: { participantCount: 2 } }));
    expect(
      restarted.opencode.session.promptAsync.mock.calls[0][0].body.parts[0].text,
    ).not.toContain("discard this old context");
    await restarted.mgr.close();
  });
  it.each(["submitting", "submitted"] as const)(
    "consumes context after recovering an accepted %s turn",
    async (state) => {
      const d = makeManager();
      d.config.gateway.groupReplyMode = "mention";
      await d.mgr.handleInbound(
        sms("already accepted history", { group: { participantCount: 2 } }),
      );
      const context = d.state.listTurns()[0];
      d.state.saveTurn({
        id: "accepted",
        messageID: "accepted",
        chatKey: "ck",
        sessionID: "existing",
        state,
        kind: "normal",
        text: "previous question",
        deliver: true,
        replyTarget: { channel: "sms", conversationId: "conv-1" },
        contextIds: [context.id],
        createdAt: 2,
        updatedAt: 2,
      });
      d.messages.set("existing", [
        { info: { id: "accepted", role: "user" }, parts: [] },
        {
          info: {
            id: "answer",
            role: "assistant",
            parentID: "accepted",
            finish: "stop",
            time: { completed: Date.now() },
          },
          parts: [{ type: "text", text: "old answer" }],
        },
      ]);
      await d.mgr.catchUp();
      await vi.waitFor(() => expect(d.state.getTurn("accepted")?.state).toBe("delivered"));
      expect(d.state.getTurn(context.id)?.consumedBy).toBe("accepted");
      await d.mgr.handleInbound(sms("@agent new question", { group: { participantCount: 2 } }));
      expect(d.opencode.session.promptAsync.mock.calls[0][0].body.parts[0].text).not.toContain(
        "already accepted history",
      );
      await d.mgr.close();
    },
  );
});

describe("local Companion policy and historical receipt boundaries", () => {
  it("does not consume an approval from a late historical webhook", async () => {
    const d = makeManager();
    const loadInitialization = vi.fn(async () => snapshot());
    d.inkbox.getClient.mockResolvedValue({ companion: { loadInitialization } });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("delivered"));
    d.companionControl.mockClear();
    d.companionControl.mockResolvedValue(true);
    await d.mgr.acceptCompanion(
      { ...companion("live", 2), sourceId: "fred", from: "fred@example.com", rawText: "allow" },
      "historical permission-looking message",
    );
    expect(d.companionControl).not.toHaveBeenCalled();
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    expect(loadInitialization).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
  it("retains local send policy changes without reloading activation history", async () => {
    const d = makeManager();
    const loadInitialization = vi.fn(async () => snapshot());
    d.inkbox.getClient.mockResolvedValue({ companion: { loadInitialization } });
    const prompt = d.opencode.session.promptAsync.getMockImplementation();
    if (!prompt) throw new Error("Missing test host implementation");
    d.opencode.session.promptAsync.mockImplementationOnce(async (input) => {
      const result = await prompt(input);
      d.companionLocalAllowed.mockReturnValue(false);
      return result;
    });
    await d.mgr.acceptCompanion(companion(), "trigger");
    await vi.waitFor(() => expect(d.state.listTurns()[0].retryAt).toBeGreaterThan(0));
    expect(d.identity.sendText).not.toHaveBeenCalled();
    expect(d.state.listTurns()[0].output).toBe("reply");
    d.companionLocalAllowed.mockReturnValue(true);
    await vi.waitFor(() => expect(d.identity.sendText).toHaveBeenCalledOnce());
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    expect(loadInitialization).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
});

it("rejects an email reply anchor that is not the stored sponsor trigger", async () => {
  const d = makeManager();
  const received = companion();
  received.metadata.channel = "mail";
  d.inkbox.getClient.mockResolvedValue({
    companion: {
      loadInitialization: vi.fn(async () => ({
        ...snapshot(),
        channel: "mail",
        replyContext: {
          channel: "mail",
          conversationId: "conversation-1",
          replyToMessageId: "another-message",
          to: [received.from],
          cc: [],
        },
      })),
    },
  });
  await d.mgr.acceptCompanion(received, "trigger");
  await vi.waitFor(() => expect(d.state.listTurns()[0].retryAt).toBeGreaterThan(0));
  expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
  expect(d.identity.replyAllEmail).not.toHaveBeenCalled();
  await d.mgr.close();
});

it("retains the first persisted receipt's sender access on webhook retries", async () => {
  const d = makeManager();
  const c = companion("live", 2);
  const chatKey = companionChatKey(c.identityId, c.metadata);
  d.state.saveTurn({
    id: `${chatKey}:history`,
    messageID: "history",
    chatKey,
    state: "context_only",
    kind: "capture",
    text: "snapshot",
    deliver: false,
    historyTriggerId: "source-1",
    companion: { ...companion(), hydrated: true },
    replyTarget: { channel: "sms", conversationId: "conversation-1", companionSponsor: c.from },
    createdAt: 1,
    updatedAt: 1,
  });
  d.state.saveTurn({
    id: `${chatKey}:event:${c.sourceId}`,
    messageID: "persisted",
    chatKey,
    state: "hydrating",
    kind: "capture",
    text: "allow",
    deliver: true,
    companion: { ...c, rawText: "allow", senderAccess: "sponsored" },
    createdAt: 2,
    updatedAt: 2,
  });
  d.companionControl.mockResolvedValue(true);
  await d.mgr.acceptCompanion({ ...c, rawText: "allow", senderAccess: "direct" }, "allow");
  await vi.waitFor(() =>
    expect(d.state.getTurn(`${chatKey}:event:${c.sourceId}`)?.state).toBe("context_only"),
  );
  expect(d.companionControl).not.toHaveBeenCalled();
  expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
  expect(d.state.getTurn(`${chatKey}:event:${c.sourceId}`)?.companion?.senderAccess).toBe(
    "sponsored",
  );
  await d.mgr.close();
});

describe("reviewed recovery and approval boundaries", () => {
  it("ignores a late initializer already included by a running live-first turn", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    await d.mgr.acceptCompanion(companion("live", 2), "current live message");
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());
    const live = d.state.listTurns().find((turn) => turn.state === "submitted");
    if (!live?.sessionID) throw new Error("Expected submitted live turn");
    await d.mgr.acceptCompanion(companion(), "late trigger webhook");
    expect(d.state.listTurns().find((turn) => turn.companion?.sourceId === "source-1")?.state).toBe(
      "delivered",
    );
    const messages = d.messages.get(live.sessionID);
    messages?.push({
      info: {
        id: "answer",
        role: "assistant",
        parentID: live.messageID,
        finish: "stop",
        time: { completed: Date.now() },
      },
      parts: [{ type: "text", text: "live answer" }],
    });
    delete d.statuses[live.sessionID];
    await vi.waitFor(() => expect(d.identity.sendText).toHaveBeenCalledOnce());
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
  it("answers an ordinary-phase Companion approval before its host turn completes", async () => {
    const d = makeManager();
    d.setAutoComplete(false);
    const target = {
      channel: "sms" as const,
      conversationId: "conversation-1",
      sender: "sponsor@example.com",
      companionMode: true,
    };
    await d.mgr.acceptCompanion(companion("ordinary"), "request", target);
    await vi.waitFor(() => expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce());
    d.companionControl.mockClear();
    d.companionControl.mockImplementation(async (turn) => turn.rawText === "allow");
    await d.mgr.acceptCompanion({ ...companion("ordinary", 2), rawText: "allow" }, "allow", target);
    expect(d.companionControl).toHaveBeenCalledOnce();
    expect(
      d.state.listTurns().find((turn) => turn.companion?.sourceId === "source-2")?.controlHandled,
    ).toBe(true);
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    await d.mgr.close();
  });
  it.each([false, true])(
    "bounds permanent hydration failures while transport=%s remains retryable",
    async (transport) => {
      const d = makeManager();
      const c = companion();
      const chatKey = companionChatKey(c.identityId, c.metadata);
      d.state.saveTurn({
        id: "pending",
        messageID: "pending",
        chatKey,
        state: "hydrating",
        kind: "capture",
        text: "input",
        deliver: true,
        companion: c,
        retryCount: 5,
        createdAt: 1,
        updatedAt: 1,
      });
      d.inkbox.getClient.mockRejectedValue(
        Object.assign(new Error("snapshot unavailable"), transport ? { status: 503 } : {}),
      );
      await d.mgr.catchUp();
      await vi.waitFor(() => expect(d.state.getTurn("pending")?.retryCount).toBe(6));
      expect(d.state.getTurn("pending")?.state).toBe(transport ? "hydrating" : "paused");
      expect(Boolean(d.state.getTurn("pending")?.retryAt)).toBe(transport);
      expect(d.opencode.session.promptAsync).not.toHaveBeenCalled();
      await d.mgr.close();
    },
  );
  it.each(["sms", "imessage"] as const)(
    "recovers an over-length ordinary %s reply without a send or infinite retry",
    async (channel) => {
      const d = makeManager();
      d.setReply("x".repeat(channel === "sms" ? 1601 : 18996));
      const prompt = d.opencode.session.promptAsync.getMockImplementation();
      if (!prompt) throw new Error("Missing test host implementation");
      d.opencode.session.promptAsync.mockImplementationOnce(async (input) => {
        const result = await prompt(input);
        d.setReply("short correction");
        return result;
      });
      await d.mgr.handleInbound(sms("question", { channel }));
      const send = channel === "sms" ? d.identity.sendText : d.identity.sendIMessage;
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(d.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
      expect(d.opencode.session.promptAsync.mock.calls[1][0].body.parts[0].text).toContain(
        "MUST send exactly one safe",
      );
      expect(d.state.listTurns()[0].retryAt).toBeUndefined();
      await d.mgr.close();
    },
  );
  it("pauses an over-length Companion result without rerunning or sending", async () => {
    const d = makeManager();
    d.setReply("x".repeat(1601));
    d.inkbox.getClient.mockResolvedValue({
      companion: { loadInitialization: vi.fn(async () => snapshot()) },
    });
    await d.mgr.acceptCompanion(companion(), "request");
    await vi.waitFor(() => expect(d.state.listTurns()[0].state).toBe("paused"));
    expect(d.opencode.session.promptAsync).toHaveBeenCalledOnce();
    expect(d.identity.sendText).not.toHaveBeenCalled();
    expect(d.state.listTurns()[0].retryAt).toBeUndefined();
    await d.mgr.close();
  });
  it("captures an existing contact reply route before a later inbound changes it", async () => {
    const d = makeManager();
    d.state.setReplyTarget("ck", {
      channel: "email",
      sender: "person@example.com",
      messageId: "original-message",
    });
    const capture = d.mgr.runCapture("ck", "follow-up task");
    d.state.setReplyTarget("ck", { channel: "sms", sender: "+15550000001" });
    await capture;
    expect(d.state.listTurns()[0].replyTarget).toMatchObject({
      channel: "email",
      messageId: "original-message",
    });
    await d.mgr.close();
  });
});
