import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import type { CompanionTurn } from "../../src/gateway/companion.js";
import { startGateway } from "../../src/gateway/index.js";
import { createStateStore } from "../../src/gateway/state.js";
import type { ReplyTarget } from "../../src/gateway/types.js";

const hooks = vi.hoisted(() => ({
  manager: undefined as any,
  escalation: undefined as any,
  server: undefined as any,
  inbound: vi.fn(async (_message: any) => {}),
  abort: vi.fn(async () => true),
  reset: vi.fn(async (_key: string) => {}),
  realSessions: false,
}));
vi.mock("../../src/gateway/sessions.js", async (load) => {
  const actual = await load<typeof import("../../src/gateway/sessions.js")>();
  return {
    createSessionManager: (deps: any) => {
      hooks.manager = deps;
      if (hooks.realSessions) return actual.createSessionManager(deps);
      return {
        handleInbound: hooks.inbound,
        abortTurn: hooks.abort,
        resetSession: hooks.reset,
        catchUp: async () => {},
        close: async () => {},
      };
    },
  };
});
vi.mock("../../src/gateway/escalation.js", () => ({
  createEscalationBridge: (deps: any) => {
    hooks.escalation = deps;
    return {
      catchUp: async () => {},
      handlePermission: async () => {},
      close: async () => {},
      detach: async () => {},
      reconcile: async () => {},
    };
  },
}));
vi.mock("../../src/gateway/server.js", () => ({
  createWebhookServer: (deps: any) => {
    hooks.server = deps;
    return { listen: async () => {}, close: async () => {} };
  },
}));
vi.mock("../../src/gateway/transport.js", () => ({
  openTransport: async () => ({ publicUrl: "https://gateway.example.com", close: async () => {} }),
}));
vi.mock("../../src/gateway/subscriptions.js", () => ({ reconcileSubscriptions: async () => {} }));
vi.mock("../../src/gateway/a2a.js", () => ({
  createA2AHandler: () => ({
    handles: () => false,
    catchUp: async () => {},
    close: async () => {},
  }),
}));
vi.mock("../../src/gateway/hosted-call-completion.js", () => ({
  createHostedCallCompletion: () => ({ catchUp: async () => {} }),
}));
vi.mock("../../src/gateway/dispatch.js", async (load) => ({
  ...(await load<any>()),
  dispatchEvent: (deps: any, event: any) => deps.sessions.handleInbound(event.body.message),
}));

const dirs: string[] = [];
const gateways: Awaited<ReturnType<typeof startGateway>>[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  hooks.inbound.mockClear();
  hooks.abort.mockClear();
  hooks.reset.mockClear();
  hooks.realSessions = false;
});
async function start(
  previousInventoryReady?: boolean,
  existingDir?: string,
  native?: { messages: Map<string, any[]>; statuses: Record<string, { type: string }> },
) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gw-wiring-"));
  if (!existingDir) dirs.push(dir);
  vi.stubEnv("INKBOX_OPENCODE_HOME", dir);
  if (previousInventoryReady !== undefined)
    createStateStore(dir).update({ permissionInventory: { ready: previousInventoryReady } });
  const gateway = defaultGatewayConfig();
  const config = {
    gateway: { ...gateway, permissionTimeoutS: 1, voice: { ...gateway.voice, enabled: false } },
    outbound: { allowedRecipients: [] as string[], approval: "ask", askTimeoutMs: 1000 },
  } as ResolvedConfig;
  const identity = {
    sendText: vi.fn(async (_input: { text: string }) => ({ id: "sent" })),
    replyAllEmail: vi.fn(async () => ({ id: "sent-email" })),
  };
  const inkbox = {
    getIdentity: async () => identity,
    getClient: async () => ({ contacts: { lookup: async () => [] } }),
  };
  const messages = native?.messages ?? new Map<string, any[]>();
  const statuses: Record<string, { type: string }> = native?.statuses ?? {};
  const opencode = {
    event: { subscribe: () => new Promise(() => {}) },
    session: {
      list: vi.fn(async () => ({ data: [{ id: "session-a" }, { id: "session-b" }] })),
      create: vi.fn(async () => ({ data: { id: "active-session" } })),
      get: vi.fn(async ({ path: { id } }: any) => ({ data: { id, directory: "/project" } })),
      promptAsync: vi.fn(async ({ path: { id }, body }: any) => {
        messages.set(id, [
          ...(messages.get(id) ?? []),
          { info: { id: body.messageID, role: "user" }, parts: body.parts },
        ]);
        statuses[id] = { type: "busy" };
        return { data: undefined };
      }),
      messages: vi.fn(async ({ path: { id } }: any) => ({ data: messages.get(id) ?? [] })),
      status: vi.fn(async () => ({ data: { ...statuses } })),
      abort: vi.fn(async ({ path: { id } }: any) => {
        delete statuses[id];
        return { data: true };
      }),
    },
  };
  gateways.push(
    await startGateway({
      inkbox: inkbox as never,
      opencode: opencode as never,
      config,
      directory: "/project",
      ownsProcess: false,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }),
  );
  return { config, identity, inkbox, dir, opencode, messages, statuses, gateway: gateways.at(-1)! };
}
function inbound(text: string, sender: string, channel = "sms", group = false) {
  return hooks.server.onEvent({
    body: {
      message: {
        chatKey: "contact-1",
        from: sender,
        channel,
        text,
        rawText: text,
        mediaPaths: [],
        ...(group ? { group: { participantCount: 2 }, conversationId: "group-1" } : {}),
      },
    },
  });
}

it("allows default Companion sponsors and still honors explicit local recipient and sender restrictions", async () => {
  const d = await start();
  expect(await hooks.manager.companionSenderAllowed("person@example.com", true)).toBe(true);
  d.config.outbound.allowedRecipients = ["other@example.com"];
  expect(await hooks.manager.companionSenderAllowed("person@example.com", true)).toBe(false);
  d.config.outbound.allowedRecipients = [];
  d.config.gateway.allowAllUsers = false;
  d.config.gateway.allowedUsers = ["other@example.com"];
  expect(await hooks.manager.companionSenderAllowed("person@example.com", true)).toBe(false);
});

it("consumes a direct contact's cross-channel free-text answer without starting another turn", async () => {
  await start();
  const answer = hooks.escalation.relay.ask("contact-1", "Approve?", {
    channel: "email",
    messageId: "parent",
    sender: "person@example.com",
    group: false,
  });
  await inbound("yes please go ahead", "+15550000001");
  expect(await answer).toBe("yes please go ahead");
  expect(hooks.inbound).not.toHaveBeenCalled();
});

it("binds a shared group's approval to its asked author and requires an approval token", async () => {
  await start();
  const target: ReplyTarget = {
    channel: "sms",
    conversationId: "group-1",
    sender: "+15550000001",
    group: true,
  };
  const answer = hooks.escalation.relay.ask("contact-1", "Approve?", target);
  await inbound("allow", "+15550000002", "sms", true);
  await inbound("unrelated conversation", "+15550000002", "sms", true);
  expect(hooks.inbound).toHaveBeenCalledTimes(2);
  await inbound("allow", target.sender ?? "", "sms", true);
  expect(await answer).toBe("allow");
  expect(hooks.inbound).toHaveBeenCalledTimes(2);
});

it("allows ordinary Companion answers under the current sender and mention gates", async () => {
  const d = await start();
  d.config.gateway.groupReplyMode = "mention";
  const target: ReplyTarget = {
    channel: "sms",
    conversationId: "group-1",
    sender: "+15550000001",
    companionMode: true,
  };
  const answer = hooks.escalation.relay.ask("contact-1", "Approve?", target);
  const turn: CompanionTurn = {
    identityId: "identity",
    handle: "agent",
    sourceId: "source",
    from: target.sender ?? "",
    rawText: "@agent allow",
    senderAccess: "direct",
    initialization: false,
    metadata: {
      phase: "ordinary",
      channel: "phone",
      scope_id: "scope",
      conversation_id: "group-1",
      sequence: 2,
    },
  };
  expect(
    await hooks.manager.companionControl(
      { ...turn, senderAccess: "sponsored" },
      "contact-1",
      target,
    ),
  ).toBe(false);
  expect(await hooks.manager.companionControl(turn, "contact-1", target)).toBe(true);
  expect(await answer).toBe("allow");
  expect(d.identity.sendText.mock.calls[0][0].text).toContain("@agent");
});

it("only treats exact supported sponsor commands as Companion controls", async () => {
  await start();
  const target: ReplyTarget = {
    channel: "sms",
    conversationId: "group",
    companionSponsor: "+15550000001",
    sender: "+15550000002",
    companionMode: true,
  };
  const turn: CompanionTurn = {
    identityId: "identity",
    handle: "agent",
    sourceId: "source",
    from: "+15550000001",
    rawText: "@agent /stop extra",
    senderAccess: "direct",
    initialization: false,
    metadata: {
      phase: "live",
      channel: "phone",
      scope_id: "scope",
      activation_id: "activation",
      conversation_id: "group",
      sequence: 2,
    },
  };
  for (const rawText of ["@agent /stop extra", "@agent /approve", "@agent /status check"])
    expect(await hooks.manager.companionControl({ ...turn, rawText }, "contact-1", target)).toBe(
      false,
    );
  expect(hooks.abort).not.toHaveBeenCalled();
  expect(
    await hooks.manager.companionControl({ ...turn, rawText: "@agent /stop" }, "contact-1", target),
  ).toBe(true);
  expect(hooks.abort).toHaveBeenCalledOnce();
});

it("resumes a selected Companion session only for its addressed eligible sponsor in the same scope", async () => {
  const d = await start();
  d.config.gateway.groupReplyMode = "mention";
  const target: ReplyTarget = {
    channel: "sms",
    conversationId: "group-1",
    companionSponsor: "+15550000001",
    sender: "+15550000002",
    companionMode: true,
  };
  const turn: CompanionTurn = {
    identityId: "identity",
    handle: "agent",
    sourceId: "source",
    from: "+15550000001",
    rawText: "@agent /resume",
    senderAccess: "direct",
    initialization: false,
    metadata: {
      phase: "live",
      channel: "phone",
      scope_id: "scope",
      activation_id: "activation",
      conversation_id: "group-1",
      sequence: 2,
    },
  };
  expect(await hooks.manager.companionControl(turn, "companion-scope", target)).toBe(true);
  const selection = { ...turn, rawText: "@agent 2" };
  for (const changed of [
    { ...selection, from: "+15550000002" },
    { ...selection, senderAccess: "sponsored" },
    { ...selection, rawText: "2" },
    { ...selection, rawText: "@agent 2 extra" },
  ])
    expect(await hooks.manager.companionControl(changed, "companion-scope", target)).toBe(false);
  expect(await hooks.manager.companionControl(selection, "other-scope", target)).toBe(false);
  expect(hooks.reset).not.toHaveBeenCalled();
  expect(await hooks.manager.companionControl(selection, "companion-scope", target)).toBe(true);
  expect(hooks.reset).toHaveBeenCalledExactlyOnceWith("companion-scope");
  expect(hooks.manager.state.getSession("companion-scope")).toBe("session-b");
  expect(hooks.manager.state.getSession("other-scope")).toBeUndefined();
  expect(await hooks.manager.companionControl(selection, "companion-scope", target)).toBe(false);
  expect(d.identity.sendText).toHaveBeenCalledTimes(2);
});

it("resets the old ordinary group turn before a valid asked-author resume selection", async () => {
  await start();
  hooks.manager.state.setSession("contact-1", "old-active-session");
  const sender = "+15550000001";
  await inbound("/resume", sender, "sms", true);
  await inbound("2", "+15550000002", "sms", true);
  expect(hooks.reset).not.toHaveBeenCalled();
  await inbound("2 words", sender, "sms", true);
  expect(hooks.reset).not.toHaveBeenCalled();
  expect(hooks.manager.state.getSession("contact-1")).toBe("old-active-session");
  await inbound("/resume", sender, "sms", true);
  hooks.reset.mockImplementationOnce(async (key) => {
    expect(key).toBe("contact-1");
    expect(hooks.manager.state.getSession(key)).toBe("old-active-session");
  });
  await inbound("2", sender, "sms", true);
  expect(hooks.reset).toHaveBeenCalledExactlyOnceWith("contact-1");
  expect(hooks.manager.state.getSession("contact-1")).toBe("session-b");
});

it("cancels only an admitted same-author group instruction's obsolete permission", async () => {
  const d = await start();
  d.config.gateway.groupReplyMode = "mention";
  const target: ReplyTarget = {
    channel: "sms",
    conversationId: "group-1",
    sender: "+15550000001",
    group: true,
  };
  let settled = false;
  const answer = hooks.escalation.relay
    .ask("contact-1", "Approve?", target)
    .then((value: unknown) => {
      settled = true;
      return value;
    });
  await inbound("yes", target.sender!, "sms", true);
  await inbound("@agent do another task", "+15550000002", "sms", true);
  expect(settled).toBe(false);
  await inbound("@agent implement the new request", target.sender!, "sms", true);
  expect(await answer).toBeUndefined();
  expect(hooks.inbound).toHaveBeenCalledTimes(3);
  expect(hooks.inbound.mock.calls[2][0]).toMatchObject({
    text: "@agent implement the new request",
  });
  expect(hooks.abort).not.toHaveBeenCalled();
});

it("keeps ordinary Slack approval ownership scoped to admitted actor and native thread", async () => {
  const d = await start();
  d.config.gateway.slackEnabled = true;
  d.config.gateway.groupReplyMode = "mention";
  const route = {
    identityId: "identity",
    connectionId: "connection",
    workspaceId: "TTEAM",
    conversationId: "CROOM",
    actorId: "UPERSON",
    messageTs: "100.000001",
    threadTs: "100.000001",
    sourceEventId: "permission-owner",
    author: "TTEAM:UPERSON",
    mentioned: true,
    addressed: true,
    direct: false,
    rawText: "question",
    text: "question",
  };
  const sendMessage = vi.fn(async () => ({ status: "sent", id: "action" }));
  d.inkbox.getClient = async () =>
    ({
      slack: {
        listConnections: async () => ({
          connections: [
            {
              id: route.connectionId,
              identityId: route.identityId,
              workspaceId: route.workspaceId,
              status: "connected",
            },
          ],
        }),
        sendMessage,
      },
    }) as any;
  const target: ReplyTarget = { channel: "slack", slack: route, sender: route.author, group: true };
  let settled = false;
  const answer = hooks.escalation.relay.ask("contact-1", "Approve?", target).then((v: unknown) => {
    settled = true;
    return v;
  });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  const message = async (text: string, changes = {}) => {
    const slack = { ...route, ...changes };
    await hooks.server.onEvent({
      body: {
        message: {
          chatKey: "contact-1",
          channel: "slack",
          from: slack.author,
          slack,
          text,
          rawText: text,
          group: { participantCount: 2 },
          mediaPaths: [],
        },
      },
    });
  };
  await message("yes", { mentioned: false });
  await message("new task", { author: "TTEAM:UOTHER", actorId: "UOTHER" });
  await message("new task", { threadTs: "200.000002" });
  expect(settled).toBe(false);
  await message("implement this new request");
  expect(await answer).toBeUndefined();
  expect(hooks.inbound).toHaveBeenCalledTimes(4);
  expect(
    hooks.inbound.mock.calls.filter(([m]) => m.text === "implement this new request"),
  ).toHaveLength(1);
  expect(hooks.abort).not.toHaveBeenCalled();
});

it("does not route an owned permission without a source target to a newer stored destination", async () => {
  const { identity } = await start();
  hooks.manager.state.setReplyTarget("owned", {
    channel: "sms",
    to: "+15550000001",
    sender: "+15550000001",
  });
  const result = await hooks.escalation.relay.ask("owned", "Approve?", undefined, {
    signal: new AbortController().signal,
    timeoutMs: 1000,
    current: () => true,
  });
  expect(result).toBeUndefined();
  expect(identity.sendText).not.toHaveBeenCalled();
  expect(identity.replyAllEmail).not.toHaveBeenCalled();
});

it("starts native inventory readiness unconfirmed instead of inheriting a prior attachment's result", async () => {
  await start(true);
  expect(hooks.manager.state.read().permissionInventory).toEqual({ ready: false });
});

function waInput(text: string, sender: string, messageId: string, group = false) {
  return hooks.server.onEvent({
    body: {
      message: {
        chatKey: "contact-1",
        from: sender,
        channel: "whatsapp",
        text,
        rawText: text,
        mediaPaths: [],
        conversationId: "wa-conversation",
        messageId,
        whatsappSource: { messageId, identityId: "wa-identity" },
        ...(group ? { group: { participantCount: 2 } } : {}),
      },
    },
  });
}
function enableWhatsApp(fixture: Awaited<ReturnType<typeof start>>) {
  Object.assign(fixture.identity, {
    id: "wa-identity",
    agentHandle: "test-agent",
    sendWhatsApp: vi.fn(async () => ({ id: "wa-sent" })),
    getWhatsAppConversation: vi.fn(async () => ({
      agentIdentityId: "wa-identity",
      isGroup: true,
      participants: ["+15550000001", "+15550000002"],
      unresolvedParticipantCount: 0,
    })),
  });
}
it.each(["/stop", "/cancel"])(
  "does not disclose or interrupt another group sender's work on %s",
  async (command) => {
    hooks.realSessions = true;
    const f = await start();
    enableWhatsApp(f);
    await waInput("Other participant's task", "+15550000002", "other-participant-task", true);
    const state = hooks.manager.state;
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const other = state.listTurns()[0];
    await waInput(command, "+15550000001", "scoped-stop", true);
    expect((f.identity as any).sendWhatsApp).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "No matching work was stopped." }),
    );
    expect(state.getTurn(other.id)?.state).toBe("submitted");
    expect(f.opencode.session.abort).not.toHaveBeenCalled();
  },
);
it("never lets a replayed WhatsApp approval approve a later permission, even across restart", async () => {
  const first = await start();
  enableWhatsApp(first);
  const target: ReplyTarget = {
    channel: "whatsapp",
    sender: "+15550000001",
    conversationId: "wa-conversation",
  };
  const answer = hooks.escalation.relay.ask("contact-1", "First approval", target);
  await waInput("allow", target.sender!, "approval-original");
  expect(await answer).toBe("allow");
  await first.gateway.close();
  const next = await start(undefined, first.dir);
  enableWhatsApp(next);
  let settled = false;
  const second = hooks.escalation.relay
    .ask("contact-1", "Second approval", target)
    .then((value: string) => {
      settled = true;
      return value;
    });
  await waInput("allow", target.sender!, "approval-original");
  expect(settled).toBe(false);
  await waInput("allow", target.sender!, "approval-new");
  expect(await second).toBe("allow");
});
it("does not consume or cancel a legacy SMS/email permission from WhatsApp", async () => {
  const f = await start();
  enableWhatsApp(f);
  let settled = false;
  const answer = hooks.escalation.relay
    .ask("contact-1", "Email approval", {
      channel: "email",
      sender: "person@example.com",
      messageId: "parent",
    })
    .then((value: string) => {
      settled = true;
      return value;
    });
  await waInput("allow", "+15550000001", "wrong-channel");
  expect(settled).toBe(false);
  await inbound("allow", "+15550000001", "sms");
  expect(await answer).toBe("allow");
});
it.each(["allow", "@agent allow"])(
  "accepts source-matched WhatsApp group permission answers before mention gating: %s",
  async (text) => {
    const f = await start();
    enableWhatsApp(f);
    f.config.gateway.groupReplyMode = "mention";
    let settled = false;
    const target: ReplyTarget = {
      channel: "whatsapp",
      sender: "+15550000001",
      conversationId: "wa-conversation",
      group: true,
    };
    const answer = hooks.escalation.relay
      .ask("contact-1", "Group approval", target)
      .then((value: string) => {
        settled = true;
        return value;
      });
    await waInput(text, "+15550000002", "foreign-author", true);
    expect(settled).toBe(false);
    await waInput(text, target.sender!, "asked-author", true);
    expect(await answer).toBe("allow");
  },
);
it("fences queued group controls by author and never repeats a consumed Stop", async () => {
  const f = await start();
  enableWhatsApp(f);
  hooks.manager.state.saveTurn({
    id: "queued-wa",
    messageID: "input",
    chatKey: "contact-1",
    state: "queued",
    kind: "normal",
    text: "Work",
    deliver: true,
    replyTarget: { channel: "whatsapp", sender: "+15550000001", conversationId: "wa-conversation" },
    createdAt: 1,
    updatedAt: 1,
  });
  await waInput("/stop", "+15550000002", "foreign-stop", true);
  expect(hooks.abort).toHaveBeenCalledExactlyOnceWith(
    "contact-1",
    "whatsapp",
    expect.objectContaining({ sender: "+15550000002", conversationId: "wa-conversation" }),
    [],
  );
  hooks.abort.mockClear();
  await waInput("@agent /stop", "+15550000001", "original-stop", true);
  expect(hooks.abort).toHaveBeenCalledOnce();
  expect(hooks.abort).toHaveBeenCalledWith(
    "contact-1",
    "whatsapp",
    expect.objectContaining({ sender: "+15550000001", conversationId: "wa-conversation" }),
    ["queued-wa"],
  );
  await waInput("@agent /stop", "+15550000001", "original-stop", true);
  expect(hooks.abort).toHaveBeenCalledOnce();
});

it("revalidates an SMS resume selection after WhatsApp work starts in the shared session", async () => {
  hooks.realSessions = true;
  const f = await start();
  enableWhatsApp(f);
  const sender = "+15550000001";
  await inbound("/resume", sender);
  expect(f.identity.sendText).toHaveBeenCalledOnce();
  await waInput("Keep working", sender, "active-wa");
  const state = hooks.manager.state;
  await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
  const before = state.listTurns()[0];
  const sessionID = state.getSession("contact-1");
  expect(f.statuses[sessionID]).toEqual({ type: "busy" });

  await inbound("1", sender);

  expect(state.getTurn(before.id)).toEqual(before);
  expect(state.getSession("contact-1")).toBe(sessionID);
  expect(f.statuses[sessionID]).toEqual({ type: "busy" });
  expect(f.opencode.session.abort).not.toHaveBeenCalled();
  expect(f.opencode.session.promptAsync).toHaveBeenCalledOnce();
  expect(f.identity.sendText).toHaveBeenCalledTimes(2);
  expect(f.identity.sendText).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: "This request could not change the conversation. Try again after the current task finishes.",
    }),
  );
  for (const command of ["/stop", "/cancel"]) await inbound(command, sender);
  expect(state.getTurn(before.id)?.state).toBe("submitted");
  expect(f.opencode.session.abort).not.toHaveBeenCalled();
});

it.each(["/stop", "/cancel"])(
  "%s stops only the WhatsApp source's running and queued work while another author drains",
  async (command) => {
    hooks.realSessions = true;
    const f = await start();
    enableWhatsApp(f);
    const author = "+15550000001";
    const other = "+15550000002";
    await waInput("First task", author, "running-source", true);
    const state = hooks.manager.state;
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const running = state.listTurns()[0];
    const sessionID = state.getSession("contact-1");
    await waInput("Other task", other, "other-source", true);
    await waInput("My queued task", author, "own-queued-source", true);
    const otherTurn = state.listTurns().find((turn: any) => turn.replyTarget?.sender === other)!;
    const ownQueued = state
      .listTurns()
      .find((turn: any) => turn.sourceIds?.includes("own-queued-source"))!;
    expect(otherTurn.state).toBe("queued");
    expect(ownQueued.state).toBe("queued");
    for (const [id, target] of [
      ["other-channel", { channel: "sms" }],
      ["other-conversation", { conversationId: "another-wa-conversation" }],
    ] as const)
      state.saveTurn({
        ...ownQueued,
        id,
        messageID: id,
        replyTarget: { ...ownQueued.replyTarget, ...target },
      });

    for (const reset of ["/clear", "/new", "/resume"])
      await waInput(reset, author, `reset-${reset}`, true);
    expect(state.getTurn(running.id)?.state).toBe("submitted");
    expect(state.getSession("contact-1")).toBe(sessionID);
    expect(f.opencode.session.abort).not.toHaveBeenCalled();

    await waInput(command, author, "stop-source", true);

    expect(state.getTurn(running.id)).toMatchObject({
      state: "interrupted",
      executionFenced: true,
    });
    expect(state.getTurn(ownQueued.id)?.state).toBe("interrupted");
    for (const id of ["other-channel", "other-conversation"])
      expect(state.getTurn(id)?.state).toBe("queued");
    expect(f.opencode.session.abort).toHaveBeenCalledExactlyOnceWith({
      path: { id: sessionID },
      query: { directory: "/project" },
    });
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledTimes(4);
    expect((f.identity as any).sendWhatsApp).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Stopped.", conversationId: "wa-conversation" }),
    );
    await vi.waitFor(() => expect(state.getTurn(otherTurn.id)?.state).toBe("submitted"));
    expect(f.opencode.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(state.getSession("contact-1")).toBe(sessionID);
    expect(f.statuses[sessionID]).toEqual({ type: "busy" });
    await waInput(command, author, "stop-source", true);
    expect(f.opencode.session.abort).toHaveBeenCalledOnce();
    expect(state.getTurn(otherTurn.id)?.state).toBe("submitted");
  },
);

it.each(["ok", "allow"])(
  "retries incomplete WhatsApp control-shaped admission: %s",
  async (text) => {
    hooks.realSessions = true;
    const f = await start();
    enableWhatsApp(f);
    const state = hooks.manager.state;
    const reserve = vi.spyOn(state, "reserveWhatsAppTurn");
    reserve.mockImplementationOnce(() => {
      throw new Error("admission write failed");
    });
    await expect(waInput(text, "+15550000001", "retry-control")).rejects.toThrow(
      "admission write failed",
    );
    expect(state.listTurns()).toHaveLength(0);
    await Promise.all([
      waInput(text, "+15550000001", "retry-control"),
      waInput(text, "+15550000001", "retry-control"),
    ]);
    expect(state.listTurns()).toHaveLength(1);
    expect(state.listTurns()[0].sourceIds).toEqual(["retry-control"]);
    await vi.waitFor(() => expect(f.opencode.session.promptAsync).toHaveBeenCalledOnce());
  },
);

it("does not consume a permission until its WhatsApp control checkpoint succeeds", async () => {
  const f = await start();
  enableWhatsApp(f);
  const target: ReplyTarget = {
    channel: "whatsapp",
    sender: "+15550000001",
    conversationId: "wa-conversation",
  };
  let settled = false;
  const answer = hooks.escalation.relay
    .ask("contact-1", "Approve", target)
    .then((value: string) => {
      settled = true;
      return value;
    });
  const state = hooks.manager.state;
  const update = state.updateWhatsAppSend.bind(state);
  let fail = true;
  vi.spyOn(state, "updateWhatsAppSend").mockImplementation((key: any, fn: any) =>
    update(key, (old: any) => {
      const next = fn(old);
      if (key.startsWith("ingress:") && next.completed && fail) {
        fail = false;
        throw new Error("control checkpoint failed");
      }
      return next;
    }),
  );
  await expect(waInput("allow", target.sender!, "retry-approval")).rejects.toThrow(
    "control checkpoint failed",
  );
  expect(settled).toBe(false);
  await waInput("allow", target.sender!, "retry-approval");
  expect(await answer).toBe("allow");
});

it("keeps an admitted control-shaped message out of later permissions after checkpoint failure", async () => {
  hooks.realSessions = true;
  const f = await start();
  enableWhatsApp(f);
  const state = hooks.manager.state;
  const update = state.updateWhatsAppSend.bind(state);
  let fail = true;
  vi.spyOn(state, "updateWhatsAppSend").mockImplementation((key: any, fn: any) =>
    update(key, (old: any) => {
      const next = fn(old);
      if (key.startsWith("ingress:") && next.completed && fail) {
        fail = false;
        throw new Error("completion write failed");
      }
      return next;
    }),
  );
  await expect(waInput("ok", "+15550000001", "already-admitted")).rejects.toThrow(
    "completion write failed",
  );
  expect(state.listTurns()).toHaveLength(1);
  let settled = false;
  const answer = hooks.escalation.relay
    .ask("contact-1", "Later approval", {
      channel: "whatsapp",
      sender: "+15550000001",
      conversationId: "wa-conversation",
    })
    .then((value: string) => {
      settled = true;
      return value;
    });
  await waInput("ok", "+15550000001", "already-admitted");
  expect(settled).toBe(false);
  expect(state.listTurns()).toHaveLength(1);
  await waInput("allow", "+15550000001", "fresh-approval");
  expect(await answer).toBe("allow");
});

it("does not repeat a completed WhatsApp Stop after reply failure and restart", async () => {
  const f = await start();
  enableWhatsApp(f);
  (f.identity as any).sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  await expect(waInput("/stop", "+15550000001", "completed-stop")).rejects.toThrow("not confirmed");
  expect(hooks.abort).toHaveBeenCalledOnce();
  await f.gateway.close();
  const next = await start(undefined, f.dir);
  enableWhatsApp(next);
  await waInput("/stop", "+15550000001", "completed-stop");
  expect(hooks.abort).toHaveBeenCalledOnce();
  expect((next.identity as any).sendWhatsApp).not.toHaveBeenCalled();
  await waInput("/stop", "+15550000001", "new-stop");
  expect(hooks.abort).toHaveBeenCalledTimes(2);
});

it.each(
  ["sms", "email", "imessage"].flatMap((channel) =>
    ["/stop", "/cancel"].flatMap((command) =>
      [true, false].map((waRunning) => ({ channel, command, waRunning })),
    ),
  ),
)(
  "scopes $channel $command with shared WhatsApp work (WA running: $waRunning)",
  async ({ channel, command, waRunning }) => {
    hooks.realSessions = true;
    const f = await start();
    enableWhatsApp(f);
    Object.assign(f.identity, { sendIMessage: vi.fn(async () => ({ id: "sent-imessage" })) });
    const sender = channel === "email" ? "person@example.com" : "+15550000001";
    const input = (text: string): Promise<void> =>
      hooks.server.onEvent({
        body: {
          message: {
            chatKey: "contact-1",
            from: sender,
            channel,
            text,
            rawText: text,
            mediaPaths: [],
            messageId: `input-${text}`,
          },
        },
      });
    const state = hooks.manager.state;
    let pendingWork: Promise<void> | undefined;
    if (waRunning) await waInput("WA work", "+15550000001", "wa-work");
    else {
      pendingWork = input("Other work");
      void pendingWork.catch(() => {});
    }
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const running = state.listTurns()[0];
    const sessionID = running.sessionID;
    if (waRunning) {
      state.saveTurn({
        ...running,
        id: "own-queued",
        messageID: "own-queued",
        state: "queued",
        ownerId: undefined,
        replyTarget: { channel, sender, to: sender, messageId: "original" },
      });
    } else await waInput("WA work", "+15550000001", "wa-work");
    const own = state.listTurns().find((turn: any) => turn.replyTarget?.channel === channel)!;
    const wa = state.listTurns().find((turn: any) => turn.replyTarget?.channel === "whatsapp")!;
    for (const [id, patch] of [
      ["foreign-author", { sender: "other@example.com" }],
      ["foreign-route", { conversationId: "another-route" }],
    ] as const) {
      state.saveTurn({
        ...own,
        id,
        messageID: id,
        state: "queued",
        ownerId: undefined,
        replyTarget: { ...own.replyTarget, ...patch },
      });
    }
    await input(command);
    expect(state.getTurn(own.id)?.state).toBe("interrupted");
    for (const id of ["foreign-author", "foreign-route"])
      expect(state.getTurn(id)?.state).toBe("queued");
    expect(state.getTurn(wa.id)?.state).not.toBe("interrupted");
    expect(state.getSession("contact-1")).toBe(sessionID);
    if (waRunning) {
      expect(f.opencode.session.abort).not.toHaveBeenCalled();
      expect(state.getTurn(wa.id)?.state).toBe("submitted");
    } else {
      await pendingWork;
      expect(f.opencode.session.abort).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(state.getTurn(wa.id)?.state).toBe("submitted"));
      await input(command);
      expect(f.opencode.session.abort).toHaveBeenCalledOnce();
    }
    const send =
      channel === "sms"
        ? f.identity.sendText
        : channel === "email"
          ? f.identity.replyAllEmail
          : (f.identity as any).sendIMessage;
    expect(JSON.stringify(send.mock.calls[0])).toContain("Stopped.");
  },
);

it.each(["/clear", "/new"])(
  "retries an incomplete WhatsApp command without repeating its completed effect: %s",
  async (command) => {
    const f = await start();
    enableWhatsApp(f);
    hooks.reset.mockRejectedValueOnce(new Error("reset not admitted"));
    await expect(waInput(command, "+15550000001", "retry-reset")).rejects.toThrow(
      "reset not admitted",
    );
    await Promise.all([
      waInput(command, "+15550000001", "retry-reset"),
      waInput(command, "+15550000001", "retry-reset"),
    ]);
    expect(hooks.reset).toHaveBeenCalledTimes(2);
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledOnce();
  },
);

function failNextControlCompletion() {
  const state = hooks.manager.state;
  const update = state.updateWhatsAppSend.bind(state);
  let fail = true;
  vi.spyOn(state, "updateWhatsAppSend").mockImplementation((key: any, fn: any) =>
    update(key, (old: any) => {
      const next = fn(old);
      if (key.startsWith("ingress:") && next.completed && fail) {
        fail = false;
        throw new Error("completion checkpoint failed");
      }
      return next;
    }),
  );
}

it.each([false, true])(
  "binds a failed approval checkpoint to the expired waiter (restart=%s)",
  async (restart) => {
    let f = await start();
    enableWhatsApp(f);
    const target: ReplyTarget = {
      channel: "whatsapp",
      sender: "+15550000001",
      conversationId: "wa-conversation",
    };
    const first = hooks.escalation.relay.ask("contact-1", "Approval A", target, {
      timeoutMs: 150,
      signal: new AbortController().signal,
    });
    failNextControlCompletion();
    await expect(waInput("allow", target.sender!, "expired-approval")).rejects.toThrow(
      "completion checkpoint failed",
    );
    await vi.waitFor(async () => expect(await first).toBeUndefined());
    if (restart) {
      await f.gateway.close();
      f = await start(undefined, f.dir);
      enableWhatsApp(f);
    }
    let settled = false;
    const second = hooks.escalation.relay
      .ask("contact-1", "Approval B", target)
      .then((v: string) => {
        settled = true;
        return v;
      });
    await waInput("allow", target.sender!, "expired-approval");
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(hooks.inbound).not.toHaveBeenCalled();
    await waInput("allow", target.sender!, "fresh-approval-after-expiry");
    expect(await second).toBe("allow");
  },
);

it("retains normal disposition when admission fails before a later permission opens", async () => {
  hooks.realSessions = true;
  const f = await start();
  enableWhatsApp(f);
  const state = hooks.manager.state;
  vi.spyOn(state, "reserveWhatsAppTurn").mockImplementationOnce(() => {
    throw new Error("admission write failed");
  });
  await expect(waInput("allow", "+15550000001", "normal-before-permission")).rejects.toThrow(
    "admission write failed",
  );
  let settled = false;
  const second = hooks.escalation.relay
    .ask("contact-1", "Later approval", {
      channel: "whatsapp",
      sender: "+15550000001",
      conversationId: "wa-conversation",
    })
    .then((v: string) => {
      settled = true;
      return v;
    });
  await waInput("allow", "+15550000001", "normal-before-permission");
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(state.listTurns()).toHaveLength(1);
  await waInput("allow", "+15550000001", "new-answer");
  expect(await second).toBe("allow");
});

it.each(
  ["/stop", "/cancel", "/clear", "/new"].flatMap((command) =>
    [false, true].map((restart) => ({ command, restart })),
  ),
)(
  "does not retarget $command after completion checkpoint failure (restart=$restart)",
  async ({ command, restart }) => {
    hooks.realSessions = true;
    let f = await start();
    enableWhatsApp(f);
    const sender = "+15550000001";
    await waInput("First task", sender, "checkpoint-t1");
    const state = hooks.manager.state;
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const first = state.listTurns()[0];
    failNextControlCompletion();
    await expect(waInput(command, sender, "checkpoint-control")).rejects.toThrow(
      "completion checkpoint failed",
    );
    expect(state.getTurn(first.id)?.state).toBe("interrupted");
    expect(f.opencode.session.abort).toHaveBeenCalledOnce();
    if (restart) {
      await f.gateway.close();
      f = await start(undefined, f.dir);
      enableWhatsApp(f);
    }
    await waInput("Second task", sender, "checkpoint-t2");
    const current = hooks.manager.state;
    await vi.waitFor(() =>
      expect(
        current.listTurns().find((t: any) => t.sourceIds?.includes("checkpoint-t2"))?.state,
      ).toBe("submitted"),
    );
    const second = current.listTurns().find((t: any) => t.sourceIds?.includes("checkpoint-t2"));
    const sessionID = current.getSession("contact-1");
    const aborts = f.opencode.session.abort.mock.calls.length;
    let settled = false;
    const permission = hooks.escalation.relay
      .ask("contact-1", "Second task approval", {
        channel: "whatsapp",
        sender,
        conversationId: "wa-conversation",
      })
      .then((v: string) => {
        settled = true;
        return v;
      });
    await waInput(command, sender, "checkpoint-control");
    if (["/stop", "/cancel"].includes(command))
      expect((f.identity as any).sendWhatsApp).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "No matching work was stopped.",
        }),
      );
    expect(current.getTurn(second.id)?.state).toBe("submitted");
    expect(current.getSession("contact-1")).toBe(sessionID);
    expect(f.opencode.session.abort).toHaveBeenCalledTimes(aborts);
    expect(f.statuses[sessionID]).toEqual({ type: "busy" });
    expect(settled).toBe(false);
    await waInput("allow", sender, "second-task-answer");
    expect(await permission).toBe("allow");
  },
);

it.each(
  ["/clear", "/new"].flatMap((command) =>
    [false, true].flatMap((after) => [false, true].map((restart) => ({ command, after, restart }))),
  ),
)(
  "recovers $command at session-reset publication (after=$after, restart=$restart)",
  async ({ command, after, restart }) => {
    hooks.realSessions = true;
    let f = await start();
    enableWhatsApp(f);
    const sender = "+15550000001";
    await waInput("Original work", sender, "reset-publication-work");
    const state = hooks.manager.state;
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const first = state.listTurns()[0];
    state.saveTurn({ ...first, id: "old-context", state: "context_only", consumedBy: undefined });
    const clear = state.clearSession.bind(state);
    vi.spyOn(state, "clearSession").mockImplementationOnce((...args: any[]) => {
      if (after) clear(...args);
      throw new Error("session reset publication failed");
    });
    await expect(waInput(command, sender, "reset-publication-command")).rejects.toThrow(
      "session reset publication failed",
    );
    expect(state.getTurn(first.id)?.state).toBe("interrupted");
    expect(state.getTurn("old-context")?.consumedBy).toBe(after ? "session-reset" : undefined);
    expect(Boolean(state.getSession("contact-1"))).toBe(!after);
    expect(f.opencode.session.abort).toHaveBeenCalledOnce();
    if (restart) {
      await f.gateway.close();
      f = await start(undefined, f.dir);
      enableWhatsApp(f);
    }
    state.saveTurn({ ...first, id: "later-context", state: "context_only", consumedBy: undefined });
    await waInput(command, sender, "reset-publication-command");
    expect(state.getSession("contact-1")).toBeUndefined();
    expect(state.getTurn("old-context")?.consumedBy).toBe("session-reset");
    expect(state.getTurn("later-context")?.consumedBy).toBeUndefined();
    expect(f.opencode.session.abort).toHaveBeenCalledTimes(restart ? 0 : 1);
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledOnce();
  },
);

it.each(
  ["/clear", "/new"].flatMap((command) =>
    ["none", "before-reuse", "after-reuse"].flatMap((restart) =>
      (restart === "after-reuse" ? [false] : [false, true]).map((inFlight) => ({
        command,
        restart,
        inFlight,
      })),
    ),
  ),
)(
  "preserves newer session ownership after failed $command publication (restart=$restart, inFlight=$inFlight)",
  async ({ command, restart, inFlight }) => {
    hooks.realSessions = true;
    let f = await start();
    enableWhatsApp(f);
    const sender = "+15550000001";
    await waInput("First task", sender, "reuse-t1");
    const state = hooks.manager.state;
    await vi.waitFor(() => expect(state.listTurns()[0]?.state).toBe("submitted"));
    const first = state.listTurns()[0];
    const retainedSession = state.getSession("contact-1");
    vi.spyOn(state, "clearSession").mockImplementationOnce(() => {
      throw new Error("reset publication failed before write");
    });
    await expect(waInput(command, sender, "reuse-control")).rejects.toThrow(
      "reset publication failed before write",
    );
    expect(state.getTurn(first.id)?.state).toBe("interrupted");
    expect(state.getSession("contact-1")).toBe(retainedSession);
    if (restart === "before-reuse") {
      await f.gateway.close();
      f = await start(undefined, f.dir);
      enableWhatsApp(f);
    }
    let current = hooks.manager.state;
    let release!: () => void;
    if (inFlight) {
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.opencode.session.get.mockImplementationOnce(async ({ path: { id } }: any) => {
        await held;
        return { data: { id, directory: "/project" } };
      });
      f.opencode.session.create.mockResolvedValueOnce({ data: { id: "fresh-session" } });
    }
    await waInput("Second task", sender, "reuse-t2");
    const secondTurn = () =>
      current.listTurns().find((t: any) => t.sourceIds?.includes("reuse-t2"));
    let aborts = f.opencode.session.abort.mock.calls.length;
    if (inFlight) {
      await vi.waitFor(() => expect(f.opencode.session.get).toHaveBeenCalled());
      await waInput(command, sender, "reuse-control");
      expect(current.getSession("contact-1")).toBeUndefined();
      release();
    }
    await vi.waitFor(() => expect(secondTurn()?.state).toBe("submitted"));
    const second = secondTurn();
    expect(second.retryCount).toBeUndefined();
    const expectedSession = inFlight ? "fresh-session" : retainedSession;
    expect(second.sessionID).toBe(expectedSession);
    expect(current.getSession("contact-1")).toBe(expectedSession);
    if (restart === "after-reuse") {
      await f.gateway.close();
      f = await start(undefined, f.dir, f);
      enableWhatsApp(f);
      current = hooks.manager.state;
      aborts = f.opencode.session.abort.mock.calls.length;
      await vi.waitFor(() => {
        expect(secondTurn()?.ownerId).toBeTruthy();
        expect(secondTurn()?.ownerId).not.toBe(second.ownerId);
      });
    }
    (f.opencode.session as any).message = vi.fn(async () => ({
      data: {
        info: {
          id: "reuse-assistant",
          role: "assistant",
          sessionID: second.sessionID,
          parentID: second.messageID,
        },
      },
    }));
    const owner = await hooks.escalation.resolveOwner(
      {
        permissionID: "reuse-permission",
        sessionID: second.sessionID,
        toolMessageID: "reuse-assistant",
        title: "Read directory",
      },
      new AbortController().signal,
    );
    expect(owner).toMatchObject({ turnId: second.id, messageID: second.messageID });
    expect(hooks.escalation.ownerCurrent(owner)).toBe(true);
    await waInput(command, sender, "reuse-control");
    expect(current.getSession("contact-1")).toBe(expectedSession);
    expect(current.getTurn(second.id)?.state).toBe("submitted");
    expect(hooks.escalation.ownerCurrent(owner)).toBe(true);
    expect(f.opencode.session.abort).toHaveBeenCalledTimes(aborts);
    expect(f.statuses[expectedSession]).toEqual({ type: "busy" });
    if (!inFlight)
      expect((f.identity as any).sendWhatsApp).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "Newer work kept this conversation active. Send /clear again to start fresh.",
        }),
      );
    await waInput(command, sender, "reuse-fresh-control");
    expect(current.getSession("contact-1")).toBeUndefined();
    expect(current.getTurn(second.id)?.state).toBe("interrupted");
    expect(hooks.escalation.ownerCurrent(owner)).toBe(false);
    expect(f.opencode.session.abort).toHaveBeenCalledTimes(aborts + 1);
  },
);

it("delivers identical permission prompts separately while retaining each request key", async () => {
  const f = await start();
  enableWhatsApp(f);
  const target: ReplyTarget = {
    channel: "whatsapp",
    sender: "+15550000001",
    conversationId: "wa-conversation",
    messageId: "source",
    whatsappSource: { messageId: "source", identityId: "wa-identity" },
  };
  for (const [index, requestId] of [
    "permission-one",
    "permission-two",
    "permission-two",
  ].entries()) {
    const answer = hooks.escalation.relay.ask("contact-1", "Approve?", target, {
      requestId,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await waInput("allow", target.sender!, `approval-${index}`);
    expect(await answer).toBe("allow");
  }
  const sends = (f.identity as any).sendWhatsApp.mock.calls;
  expect(sends).toHaveLength(2);
  expect(sends[0][0].idempotencyKey).not.toBe(sends[1][0].idempotencyKey);
  expect(
    Object.values(hooks.manager.state.read().whatsappSends).filter((send: any) => send.explicit),
  ).toEqual([]);
});
it.each(["/clear", "/new", "/resume", "/status", "/health", "/usage"])(
  "requires a mention for WhatsApp group command %s",
  async (command) => {
    const f = await start();
    enableWhatsApp(f);
    f.config.gateway.groupReplyMode = "mention";
    await waInput(command, "+15550000001", "unmentioned-command", true);
    expect((f.identity as any).sendWhatsApp).not.toHaveBeenCalled();
    expect(hooks.reset).not.toHaveBeenCalled();
    expect(hooks.inbound).toHaveBeenCalledOnce();
  },
);

it.each(["/clear", "/new", "/resume"])(
  "explains rejected %s without exposing or stopping another source",
  async (command) => {
    const f = await start();
    enableWhatsApp(f);
    hooks.manager.state.saveTurn({
      id: "foreign",
      messageID: "foreign",
      chatKey: "contact-1",
      state: "submitted",
      kind: "normal",
      text: "private",
      deliver: true,
      replyTarget: { channel: "email", sender: "other@example.com", messageId: "foreign" },
      createdAt: 1,
      updatedAt: 1,
    });
    await waInput(command, "+15550000001", "denied-control");
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledOnce();
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "This request could not change the conversation. Try again after the current task finishes.",
      }),
    );
    expect(hooks.reset).not.toHaveBeenCalled();
    expect(hooks.abort).not.toHaveBeenCalled();
    expect(hooks.manager.state.getTurn("foreign").state).toBe("submitted");
    await waInput(command, "+15550000001", "denied-control");
    expect((f.identity as any).sendWhatsApp).toHaveBeenCalledOnce();
  },
);
