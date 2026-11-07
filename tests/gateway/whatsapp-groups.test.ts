import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultGatewayConfig } from "../../src/config.js";
import { companionMetadata } from "../../src/gateway/companion.js";
import { dispatchEvent } from "../../src/gateway/dispatch.js";
import { companionWakes } from "../../src/gateway/response-policy.js";
import { createStateStore } from "../../src/gateway/state.js";
import {
  authorizeWhatsAppCompanion,
  nativeMentions,
  WhatsAppPreflightError,
  whatsappControlText,
} from "../../src/whatsapp-groups.js";
import { prepareWhatsApp } from "../../src/whatsapp-native.js";

const owner = "10000000-0000-4000-8000-000000000001";
const conversation = "20000000-0000-4000-8000-000000000001";
const source = "30000000-0000-4000-8000-000000000001";
const phone = "+15555550101";
const other = "+15555550102";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wa-groups-"));
  dirs.push(dir);
  const store = createStateStore(dir);
  const roster = {
    id: conversation,
    agentIdentityId: owner,
    isGroup: true,
    remoteNumber: null,
    localNumber: "+15555550100",
    unresolvedParticipantCount: 0,
    participants: [phone, other],
  };
  const identity = {
    id: owner,
    agentHandle: "sample",
    getWhatsAppConversation: vi.fn(async () => roster),
    sendWhatsApp: vi.fn(async () => ({ id: "sent" })),
  };
  const message = {
    id: source,
    agent_identity_id: owner,
    conversation_id: conversation,
    is_group: true,
    remote_number: null,
    local_number: roster.localNumber,
    unresolved_participant_count: 0,
    participants: roster.participants,
    sender_number: phone,
    direction: "inbound",
    content: "Hello @123 and @456",
    agent_mentioned: true,
    mentions: [
      { text: "@123", phone_number: roster.localNumber, is_agent: true },
      { text: "@456", phone_number: other, is_agent: false },
    ],
    media: [],
  };
  const handleInbound = vi.fn(async (_m: any) => {}),
    acceptCompanion = vi.fn(async (..._args: any[]) => {});
  const deps: any = {
    state: store,
    config: { baseUrl: "https://example.invalid", gateway: defaultGatewayConfig() },
    inkbox: { getIdentity: async () => identity },
    contacts: {
      resolve: vi.fn(async (number: string) => ({
        contactId: number,
        contactName: number === other ? "Taylor" : "Sender",
      })),
      chatKeyFor: (v: any) => v.contactId ?? `whatsapp:${v.conversationId}`,
    },
    sessions: { handleInbound, acceptCompanion },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const event = (changes: any = {}, companion?: unknown) => ({
    provider: "inkbox",
    verified: true,
    eventType: "whatsapp.received",
    headers: {},
    body: { data: { message: { ...message, ...changes } }, ...(companion ? { companion } : {}) },
  });
  return { store, identity, roster, message, deps, event, handleInbound, acceptCompanion };
}

it("routes groups by conversation and preserves native current mentions without injecting contact memories", async () => {
  const f = fixture();
  await dispatchEvent(f.deps, f.event());
  const input = f.handleInbound.mock.calls[0][0];
  expect(input).toMatchObject({
    chatKey: `whatsapp:${conversation}`,
    group: { participantCount: 2 },
    whatsappSource: { agentMentioned: true },
    contactMemories: [],
  });
  expect(input.text).toContain("Hello @123 and @456");
  expect(input.text).toContain("@sample");
  expect(input.text).toContain("Taylor");
  expect(input.rawText).toBe(f.message.content);
});
it("fails closed for unknown group roster, missing sender, old SDK metadata, and removed membership", async () => {
  const f = fixture();
  await dispatchEvent(f.deps, f.event({ unresolved_participant_count: 1 }));
  await dispatchEvent(f.deps, f.event({ sender_number: null }));
  f.identity.getWhatsAppConversation.mockResolvedValueOnce({ ...f.roster, isGroup: false } as any);
  await expect(dispatchEvent(f.deps, f.event())).rejects.toThrow("compatible SDK");
  f.identity.getWhatsAppConversation.mockResolvedValueOnce({ ...f.roster, participants: [other] });
  await dispatchEvent(f.deps, f.event());
  expect(f.handleInbound).not.toHaveBeenCalled();
});
it("enforces every ordinary group participant's local allowlist", async () => {
  const f = fixture();
  f.deps.config.gateway.allowedUsers = [phone];
  await dispatchEvent(f.deps, f.event());
  expect(f.handleInbound).not.toHaveBeenCalled();
});
it("passes canonical WhatsApp Companion sources to the existing receiver and rejects mismatched scope", async () => {
  const f = fixture();
  const metadata = {
    channel: "whatsapp",
    scope_id: "scope",
    activation_id: "activation",
    conversation_id: conversation,
    sequence: 1,
    phase: "initialization",
  };
  await dispatchEvent(f.deps, f.event({ sender_access: "direct" }, metadata));
  expect(f.acceptCompanion).toHaveBeenCalledOnce();
  expect(f.handleInbound).not.toHaveBeenCalled();
  expect(f.acceptCompanion.mock.calls[0][0]).toMatchObject({
    metadata,
    senderAccess: "direct",
    whatsappSource: { agentMentioned: true },
  });
  await expect(
    dispatchEvent(f.deps, f.event({}, { ...metadata, conversation_id: "other" })),
  ).rejects.toThrow("does not match");
});
it("uses strict native self mentions for attention and controls, never another person's mention or quoted history", () => {
  const m = nativeMentions([
    { text: "@123", phone_number: null, is_agent: true },
    { text: "@456", phone_number: other, is_agent: false },
    { text: "@789", phone_number: null, is_agent: "true" },
  ]);
  expect(m).toHaveLength(2);
  expect(whatsappControlText("@123 allow", m)).toBe("allow");
  expect(whatsappControlText("@456 allow", m)).toBe("@456 allow");
  const c: any = {
    metadata: { channel: "whatsapp" },
    rawText: "@456",
    handle: "sample",
    senderAccess: "direct",
    whatsappSource: { agentMentioned: true },
  };
  const cfg = { ...defaultGatewayConfig(), groupReplyMode: "mention" as const };
  expect(companionWakes(c, cfg)).toBe(true);
  c.whatsappSource.agentMentioned = "true";
  expect(companionWakes(c, cfg)).toBe(false);
  c.whatsappSource.agentMentioned = true;
  c.senderAccess = "sponsored";
  expect(companionWakes(c, cfg)).toBe(false);
  expect(companionWakes(c, { ...cfg, companionResponseMode: "relaxed" })).toBe(true);
});
it("keeps transient preflight failures unsent and retries the same logical group send once", async () => {
  const f = fixture();
  const target: any = {
    channel: "whatsapp",
    conversationId: conversation,
    group: true,
    messageId: source,
    whatsappSource: { identityId: owner, messageId: source },
  };
  const send = await prepareWhatsApp(f.identity as any, target, { text: "Answer" }, f.store);
  f.identity.getWhatsAppConversation.mockRejectedValueOnce(new Error("temporary roster failure"));
  await expect(send()).rejects.toBeInstanceOf(WhatsAppPreflightError);
  expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  expect(Object.keys(f.store.read().whatsappSends ?? {})).toHaveLength(0);
  await send();
  await send();
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
});
it("requires current activation and rejects borrowed cross-conversation grants", async () => {
  const f = fixture();
  const activationMessages = vi.fn(async () => ({
    scopeId: "scope",
    activationId: "activation",
    channel: "whatsapp",
    conversationId: conversation,
    replyContext: { channel: "whatsapp", conversationId: conversation },
  }));
  const runtime: any = {
    getIdentity: async () => f.identity,
    getClient: async () => ({ companion: { activationMessages } }),
  };
  const target: any = {
    channel: "whatsapp",
    conversationId: conversation,
    whatsappSource: { identityId: owner },
    whatsappCompanion: {
      handle: "sample",
      scopeId: "scope",
      activationId: "activation",
      conversationId: conversation,
    },
  };
  await authorizeWhatsAppCompanion(runtime, target);
  await expect(
    authorizeWhatsAppCompanion(runtime, { ...target, conversationId: "other" }),
  ).rejects.toThrow("another conversation");
  activationMessages.mockResolvedValueOnce({ scopeId: "replaced" } as any);
  await expect(authorizeWhatsAppCompanion(runtime, target)).rejects.toThrow("no longer matches");
  expect(
    companionMetadata({
      channel: "whatsapp",
      scope_id: "scope",
      conversation_id: conversation,
      phase: "ordinary",
      sequence: 1,
    }).channel,
  ).toBe("whatsapp");
});

it("acknowledges a correctly signed group event on an old SDK without model or send effects", async () => {
  const f = fixture();
  f.identity.getWhatsAppConversation.mockResolvedValue({
    id: conversation,
    agentIdentityId: owner,
    participants: [phone, other],
  } as any);
  const { createWebhookServer } = await import("../../src/gateway/server.js");
  const { createRequestDedup } = await import("../../src/gateway/dedup.js");
  const { inkboxProvider } = await import("../../src/gateway/providers.js");
  const { createHmac } = await import("node:crypto");
  const secret = "whsec_" + Buffer.from("synthetic-group-contract-key").toString("base64");
  const server = createWebhookServer({
    config: { ...f.deps.config, signingKey: secret },
    logger: f.deps.logger,
    dedup: createRequestDedup(),
    providers: [inkboxProvider],
    onEvent: (event) => dispatchEvent(f.deps, event),
  });
  await server.listen("127.0.0.1", 0);
  try {
    const body = JSON.stringify({ ...f.event().body, event_type: "whatsapp.received" });
    const requestId = "group-contract",
      timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac("sha256", secret.slice(6))
      .update(`${requestId}.${timestamp}.${body}`)
      .digest("hex");
    const port = (server.server.address() as { port: number }).port;
    const result = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inkbox-request-id": requestId,
        "x-inkbox-timestamp": timestamp,
        "x-inkbox-signature": `sha256=${digest}`,
      },
      body,
    });
    expect(result.status).toBe(200);
    expect(f.handleInbound).not.toHaveBeenCalled();
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
    expect(f.store.listTurns()).toHaveLength(0);
  } finally {
    await server.close();
  }
});
