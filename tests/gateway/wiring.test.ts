import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import type { CompanionTurn } from "../../src/gateway/companion.js";
import { startGateway } from "../../src/gateway/index.js";
import type { ReplyTarget } from "../../src/gateway/types.js";

const hooks = vi.hoisted(() => ({
  manager: undefined as any,
  escalation: undefined as any,
  server: undefined as any,
  inbound: vi.fn(async () => {}),
  abort: vi.fn(async () => true),
  reset: vi.fn(async (_key: string) => {}),
}));
vi.mock("../../src/gateway/sessions.js", () => ({
  createSessionManager: (deps: any) => {
    hooks.manager = deps;
    return {
      handleInbound: hooks.inbound,
      abortTurn: hooks.abort,
      resetSession: hooks.reset,
      catchUp: async () => {},
      close: async () => {},
    };
  },
}));
vi.mock("../../src/gateway/escalation.js", () => ({
  createEscalationBridge: (deps: any) => {
    hooks.escalation = deps;
    return { catchUp: async () => {}, handlePermission: async () => {} };
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
});
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-wiring-"));
  dirs.push(dir);
  vi.stubEnv("INKBOX_OPENCODE_HOME", dir);
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
  const opencode = {
    event: { subscribe: () => new Promise(() => {}) },
    session: { list: vi.fn(async () => ({ data: [{ id: "session-a" }, { id: "session-b" }] })) },
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
  return { config, identity };
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
  await inbound("unrelated conversation", target.sender ?? "", "sms", true);
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
