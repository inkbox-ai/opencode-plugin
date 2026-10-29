import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox, InkboxAPIError } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultGatewayConfig } from "../../src/config.js";
import { formatJson } from "../../src/format.js";
import { createNotifyOnce, createRequestDedup } from "../../src/gateway/dedup.js";
import { dispatchEvent } from "../../src/gateway/dispatch.js";
import { createPendingReplies } from "../../src/gateway/pending.js";
import { prepareReply } from "../../src/gateway/reply.js";
import { createWebhookServer } from "../../src/gateway/server.js";
import { createStateStore } from "../../src/gateway/state.js";
import { whatsappTools } from "../../src/tools/whatsapp.js";
import {
  assertWhatsAppOwner,
  hasExplicitWhatsAppReply,
  prepareWhatsApp,
  publicWhatsAppPolicy,
  recordWhatsAppStatus,
} from "../../src/whatsapp-native.js";

const owner = "10000000-0000-4000-8000-000000000001",
  conversation = "20000000-0000-4000-8000-000000000001",
  source = "30000000-0000-4000-8000-000000000001";
const time = "2026-10-01T12:00:00Z";
const wire = {
  id: source,
  agent_identity_id: owner,
  conversation_id: conversation,
  direction: "outbound",
  local_number: "+15555550100",
  remote_number: "+15555550101",
  sender_number: "+15555550100",
  participants: ["+15555550101"],
  is_group: false,
  content: "Saved answer",
  media: [],
  status: "sent",
  delivery_state: "unknown",
  recipients: [],
  is_read: false,
  is_blocked: false,
  error_code: null,
  error_detail: null,
  source_at: null,
  created_at: time,
  updated_at: time,
  sent_at: time,
  delivered_at: null,
  failed_at: null,
  status_observed_at: time,
  status_refresh_pending: false,
};
const target = {
  channel: "whatsapp" as const,
  conversationId: conversation,
  messageId: source,
  sender: "+15555550101",
  whatsappSource: { messageId: source, identityId: owner, autoReplyTarget: source },
};
const directories: string[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function state() {
  const path = mkdtempSync(join(tmpdir(), "whatsapp-contract-"));
  directories.push(path);
  return createStateStore(path);
}
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
async function realIdentity() {
  const sdk = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://sdk.test" });
  const identity = await sdk.getIdentity("sample-agent");
  return { sdk, identity };
}
const identityWire = {
  id: owner,
  organization_id: "org_example",
  agent_handle: "sample-agent",
  created_at: time,
  updated_at: time,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("uses the real SDK for stable source-anchored replies without unsupported fallback fields or duplicate sends", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      calls.push({ url: new URL(String(url)), init });
      return ok(
        String(url).includes("/identities/") ? identityWire : { message: wire },
        init?.method === "POST" ? 201 : 200,
      );
    }),
  );
  const { identity, sdk } = await realIdentity(),
    store = state();
  const runtime = { getIdentity: async () => identity, getClient: async () => sdk };
  const send = await prepareReply(runtime, target, "Saved answer", logger, store);
  await send();
  await (await prepareReply(runtime, target, "Saved answer", logger, store))();
  const posts = calls.filter((call) => call.init?.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0].url.pathname).toBe("/api/v1/whatsapp/messages");
  expect(posts[0].url.searchParams.get("agent_identity_id")).toBe(owner);
  expect(JSON.parse(String(posts[0].init?.body))).toEqual({
    conversation_id: conversation,
    text: "Saved answer",
    reply_to_message_id: source,
  });
  expect(new Headers(posts[0].init?.headers).get("Idempotency-Key")).toContain(
    "opencode:whatsapp:",
  );
});

const quote = "40000000-0000-4000-8000-000000000004";
const conversationWire = {
  id: conversation,
  agent_identity_id: owner,
  local_number: "+15555550100",
  remote_number: "+15555550101",
  participants: ["+15555550101"],
  is_group: false,
  unresolved_participant_count: 0,
  created_at: time,
  updated_at: time,
};
function stubSdkFetch() {
  const calls: { url: URL; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      if (parsed.pathname.includes("/identities/")) return ok(identityWire);
      if (parsed.pathname.includes("/conversations/")) return ok(conversationWire);
      return ok({ message: wire }, init?.method === "POST" ? 201 : 200);
    }),
  );
  return calls;
}
function ownedSendTool(identity: Awaited<ReturnType<typeof realIdentity>>["identity"]) {
  const store = state();
  vi.stubEnv("INKBOX_OPENCODE_HOME", directories.at(-1)!);
  store.saveTurn({
    id: "turn",
    messageID: "input",
    sessionID: "session",
    chatKey: "contact",
    state: "submitted",
    kind: "normal",
    text: "question",
    deliver: true,
    replyTarget: target,
    ownerId: "owner",
    leaseUntil: Date.now() + 60_000,
    createdAt: 1,
    updatedAt: 1,
  });
  const tool = whatsappTools({
    runtime: { getIdentity: async () => identity },
    config: { outbound: { approval: "auto", allowedRecipients: [], askTimeoutMs: 100 } },
    opencode: {
      session: {
        message: async () => ({ data: { info: { role: "assistant", parentID: "input" } } }),
      },
    },
  } as any).find((item) => item.name === "inkbox_send_whatsapp")!;
  const ctx = {
    sessionID: "session",
    messageID: "assistant",
    directory: "/tmp",
    abort: new AbortController().signal,
  } as any;
  return {
    store,
    execute: (args: Record<string, unknown>) => tool.definition.execute(args, ctx),
  };
}
function posted(calls: { url: URL; init?: RequestInit }[]) {
  return calls.filter((call) => call.init?.method === "POST");
}

it("rejects a malformed quote before recording a send, then accepts the same key once", async () => {
  const calls = stubSdkFetch();
  const { identity } = await realIdentity();
  const quoteError = "replyToMessageId requires conversationId and a valid message UUID";
  await expect(
    identity.sendWhatsApp({
      conversationId: conversation,
      text: "Hello",
      replyToMessageId: "not-a-uuid",
      idempotencyKey: "quote-key",
    }),
  ).rejects.toThrow(quoteError);
  expect(posted(calls)).toHaveLength(0);
  const tool = ownedSendTool(identity);
  await expect(
    tool.execute({
      conversationId: conversation,
      text: "Hello",
      replyToMessageId: "not-a-uuid",
      idempotencyKey: "quote-key",
    }),
  ).rejects.toThrow(quoteError);
  expect(posted(calls)).toHaveLength(0);
  expect(tool.store.read().whatsappSends ?? {}).toEqual({});
  expect(hasExplicitWhatsAppReply(target, tool.store)).toBe(false);
  await tool.execute({
    conversationId: conversation,
    text: "Hello",
    replyToMessageId: quote,
    idempotencyKey: "quote-key",
  });
  expect(posted(calls)).toHaveLength(1);
  expect(posted(calls)[0].url.pathname).toBe("/api/v1/whatsapp/messages");
  expect(JSON.parse(String(posted(calls)[0].init?.body))).toMatchObject({
    conversation_id: conversation,
    reply_to_message_id: quote,
    text: "Hello",
  });
  await tool.execute({
    conversationId: conversation,
    text: "Hello",
    replyToMessageId: quote,
    idempotencyKey: "quote-key",
  });
  expect(posted(calls)).toHaveLength(1);
  expect(hasExplicitWhatsAppReply(target, tool.store)).toBe(true);
});

it.each([
  ["", "idempotencyKey must contain between 1 and 255 characters"],
  ["k".repeat(256), "idempotencyKey must contain between 1 and 255 characters"],
  ["   ", "Use a printable ASCII idempotency key"],
  ["bad\nkey", "Use a printable ASCII idempotency key"],
  ["bad\u00e9key", "Use a printable ASCII idempotency key"],
])("rejects local idempotency key %j before recording a send", async (idempotencyKey, message) => {
  const calls = stubSdkFetch();
  const { identity } = await realIdentity();
  await expect(
    identity.sendWhatsApp({
      conversationId: conversation,
      text: "Hello",
      replyToMessageId: quote,
      idempotencyKey,
    }),
  ).rejects.toThrow(message);
  expect(posted(calls)).toHaveLength(0);
  const tool = ownedSendTool(identity);
  await expect(
    tool.execute({
      conversationId: conversation,
      text: "Hello",
      replyToMessageId: quote,
      idempotencyKey,
    }),
  ).rejects.toThrow(message);
  expect(posted(calls)).toHaveLength(0);
  expect(tool.store.read().whatsappSends ?? {}).toEqual({});
  expect(hasExplicitWhatsAppReply(target, tool.store)).toBe(false);
  await tool.execute({
    conversationId: conversation,
    text: "Hello",
    replyToMessageId: quote,
    idempotencyKey: "corrected-key",
  });
  expect(posted(calls)).toHaveLength(1);
});

it("retains the original owned attachment and logical key after ambiguity; never uploads or sends twice", async () => {
  const store = state();
  const identity: any = {
    id: owner,
    sendWhatsApp: vi.fn(async () => {
      throw new Error("lost response");
    }),
    uploadWhatsAppMedia: vi.fn(),
  };
  const send = await prepareWhatsApp(
    identity,
    target,
    { mediaIds: ["owned-media"] },
    store,
    "original-key",
  );
  await expect(send()).rejects.toThrow("idempotencyKey=original-key, mediaId=owned-media");
  await expect(
    (
      await prepareWhatsApp(identity, target, { mediaIds: ["owned-media"] }, store, "original-key")
    )(),
  ).rejects.toThrow("unconfirmed");
  expect(identity.sendWhatsApp).toHaveBeenCalledOnce();
  expect(identity.uploadWhatsAppMedia).not.toHaveBeenCalled();
  expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
});

it("rejects revoked source leases before any send and never converts a cancelled source into proactive authority", async () => {
  const store = state();
  store.saveTurn({
    id: "turn",
    messageID: "input",
    chatKey: "contact",
    state: "submitted",
    kind: "normal",
    text: "question",
    deliver: true,
    replyTarget: target,
    ownerId: "owner",
    leaseUntil: Date.now() + 10000,
    createdAt: 1,
    updatedAt: 1,
  });
  const owned = { ...target, nativeOwner: { turnId: "turn", ownerId: "owner" } };
  const identity: any = { id: owner, sendWhatsApp: vi.fn() };
  const send = await prepareWhatsApp(identity, owned, { text: "answer" }, store);
  store.updateTurn("turn", { state: "interrupted" });
  expect(() => assertWhatsAppOwner(owned, store)).toThrow("no longer owns");
  await expect(send()).rejects.toThrow("no longer owns");
  expect(identity.sendWhatsApp).not.toHaveBeenCalled();
});

it("records callback-first delivery facts without content, downgrades, wakeups, or new send attempts", () => {
  const store = state();
  recordWhatsAppStatus(
    {
      ...wire,
      status: "delivered",
      delivery_state: "delivered",
      updated_at: "2026-10-01T12:01:00Z",
    },
    owner,
    store,
  );
  recordWhatsAppStatus(wire, owner, store);
  const rows = Object.values(store.read().whatsappSends as Record<string, any>);
  expect(rows).toHaveLength(1);
  expect(rows[0].deliveryState).toBe("delivered");
  expect(rows[0]).not.toHaveProperty("content");
  expect(store.listTurns()).toEqual([]);
});

it("refreshes inbound owned media, preserves contact session convergence, and ignores malformed groups/other owners/echoes/status-only events", async () => {
  const store = state(),
    handleInbound = vi.fn(async (_message: unknown) => {});
  const identity: any = {
    id: owner,
    getWhatsAppMedia: vi.fn(async () => ({
      id: "owned-media",
      status: "ready",
      url: "https://media.test/fresh",
      contentType: "image/png",
    })),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "whatsapp-media-"));
  directories.push(dir);
  const deps: any = {
    config: { gateway: { ...defaultGatewayConfig(), allowAllUsers: true, mediaDir: dir } },
    inkbox: { getIdentity: async () => identity },
    contacts: {
      resolve: async () => ({ contactId: "contact" }),
      chatKeyFor: (input: any) => input.contactId,
    },
    sessions: { handleInbound },
    state: store,
    notify: createNotifyOnce(),
    logger,
  };
  const inbound = {
    ...wire,
    direction: "inbound",
    sender_number: "+15555550101",
    status: "received",
    media: [{ id: "owned-media", url: "https://media.test/expired" }],
  };
  const event = (message: any, type = "whatsapp.received") => ({
    provider: "inkbox",
    verified: true,
    eventType: type,
    body: { data: { message } },
    headers: {},
  });
  await dispatchEvent(deps, event(inbound));
  expect(handleInbound).toHaveBeenCalledOnce();
  expect(handleInbound.mock.calls[0][0]).toMatchObject({
    channel: "whatsapp",
    chatKey: "contact",
    whatsappSource: { mediaIds: ["owned-media"] },
  });
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://media.test/fresh");
  for (const changes of [
    { is_group: true, sender_number: null },
    { agent_identity_id: "other" },
    { sender_number: "+15555550100" },
  ])
    await dispatchEvent(deps, event({ ...inbound, ...changes }));
  await dispatchEvent(deps, event(wire, "whatsapp.delivery_unconfirmed"));
  expect(handleInbound).toHaveBeenCalledOnce();
  expect(store.listTurns()).toEqual([]);
});

it("requires signature verification even with generic checks disabled, including unknown WhatsApp events", async () => {
  const onEvent = vi.fn(async () => true);
  const server = createWebhookServer({
    config: { gateway: { ...defaultGatewayConfig(), requireSignature: false } } as any,
    logger,
    dedup: createRequestDedup(),
    providers: [
      { name: "inkbox", matches: () => true, verify: () => false, secretEnvVar: () => undefined },
    ],
    onEvent,
  });
  await server.listen("127.0.0.1", 0);
  try {
    const address = server.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      body: JSON.stringify({ event_type: "whatsapp.future" }),
    });
    expect(response.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});

it("keeps approval answers bound to channel, conversation, and author in a shared contact session", async () => {
  const pending = createPendingReplies();
  const answer = pending.await("contact", 0, {
    channel: "whatsapp",
    sender: "+15555550101",
    route: conversation,
  });
  expect(
    pending.tryConsume("contact", "allow", {
      channel: "imessage",
      sender: "+15555550101",
      route: conversation,
    }),
  ).toBe(false);
  expect(
    pending.tryConsume("contact", "allow", {
      channel: "whatsapp",
      sender: "+15555550101",
      route: "other",
    }),
  ).toBe(false);
  expect(
    pending.tryConsume("contact", "allow", {
      channel: "whatsapp",
      sender: "+15555550102",
      route: conversation,
    }),
  ).toBe(false);
  expect(
    pending.tryConsume("contact", "allow", {
      channel: "whatsapp",
      sender: "+15555550101",
      route: conversation,
    }),
  ).toBe(true);
  await expect(answer).resolves.toBe("allow");
  pending.close();
});

it("exposes the fixed owner/operation send lookup through the actual SDK", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      ok(String(url).includes("/identities/") ? identityWire : { message_id: source }),
    ),
  );
  const { identity, sdk } = await realIdentity();
  const tools = whatsappTools({
    runtime: { getIdentity: async () => identity, getClient: async () => sdk },
  } as any);
  const lookup = tools.find((tool) => tool.name === "inkbox_lookup_whatsapp_send")!;
  const context: any = {
    sessionID: "independent",
    messageID: "assistant",
    directory: "/tmp",
    abort: new AbortController().signal,
  };
  const result = await lookup.definition.execute({ idempotencyKey: "original-key" }, context);
  expect(result).toEqual(formatJson({ messageId: source }));
  const url = new URL(String(vi.mocked(fetch).mock.calls.at(-1)![0]));
  expect(url.pathname).toBe("/api/v1/message-sends/lookup");
  expect(url.searchParams.get("sender_kind")).toBe("whatsapp_identity");
  expect(url.searchParams.get("sender_id")).toBe(owner);
  expect(url.searchParams.get("operation")).toBe("whatsapp.send");
});

it("preserves only public quota fields and permits the original key after a known pre-admission rejection", async () => {
  const store = state();
  const error = new InkboxAPIError(
    429,
    {
      error: "whatsapp_daily_limit_exceeded",
      quota: "whatsapp.texts_per_agent_identity_per_24h",
      limit: 20,
      used: 20,
      retry_condition: "window_reset",
      reset_at: "2026-10-27T00:00:00Z",
      message: "untrusted body",
      credentials: "private",
    },
    "60",
  );
  expect(publicWhatsAppPolicy(error)).toEqual({
    error: "whatsapp_daily_limit_exceeded",
    quota: "whatsapp.texts_per_agent_identity_per_24h",
    limit: 20,
    used: 20,
    retry_condition: "window_reset",
    reset_at: "2026-10-27T00:00:00Z",
    retry_after_seconds: 60,
    status_code: 429,
  });
  const identity: any = {
    id: owner,
    sendWhatsApp: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ id: "accepted" }),
  };
  await expect(
    (await prepareWhatsApp(identity, target, { text: "answer" }, store, "original-key"))(),
  ).rejects.toThrow("request not accepted");
  expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
  await expect(
    (await prepareWhatsApp(identity, target, { text: "answer" }, store, "original-key"))(),
  ).resolves.toMatchObject({ id: "accepted" });
  expect(identity.sendWhatsApp.mock.calls.map((call: any[]) => call[0].idempotencyKey)).toEqual([
    "original-key",
    "original-key",
  ]);
  expect(
    publicWhatsAppPolicy(
      new InkboxAPIError(503, { error: "whatsapp_upstream", credentials: "private" }),
    ),
  ).toBeUndefined();
});

it.each([
  [403, "whatsapp_unrecognized_policy"],
  [422, "whatsapp_unrecognized_policy"],
  [429, "whatsapp_unrecognized_policy"],
  [402, "whatsapp_cycle_limit_exceeded"],
] as const)(
  "does not free send fencing for an unrecognized public-looking error (%s/%s)",
  async (status, code) => {
    const store = state();
    const error = new InkboxAPIError(status, { error: code });
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ id: "must-not-repeat" });
    const identity: any = { id: owner, sendWhatsApp };
    await expect(
      (await prepareWhatsApp(identity, target, { text: "answer" }, store, "original-key"))(),
    ).rejects.toThrow("not confirmed");
    expect(publicWhatsAppPolicy(error)).toBeUndefined();
    expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
    await expect(
      (await prepareWhatsApp(identity, target, { text: "answer" }, store, "original-key"))(),
    ).rejects.toThrow("unconfirmed");
    expect(sendWhatsApp).toHaveBeenCalledOnce();
  },
);

it("curates email policy rejection and recovers only the original send key", async () => {
  const store = state();
  const policy = {
    error: "whatsapp_reply_required_for_email_addresses",
    quota: "whatsapp.pre_reply_email_addresses_allowed",
    limit: 0,
    retry_condition: "recipient_reply_or_configuration",
  };
  const error = new InkboxAPIError(422, { ...policy, message: "private-diagnostic" });
  expect(publicWhatsAppPolicy(error)).toEqual({ ...policy, status_code: 422 });
  expect(publicWhatsAppPolicy(new InkboxAPIError(429, policy))).toBeUndefined();
  const sendWhatsApp = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ id: "accepted-original" });
  const identity: any = { id: owner, sendWhatsApp };
  const send = () =>
    prepareWhatsApp(
      identity,
      target,
      { text: "Email sender@example.com" },
      store,
      "original-email-key",
    );
  await expect((await send())()).rejects.toThrow("request not accepted");
  expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
  await expect((await send())()).resolves.toMatchObject({ id: "accepted-original" });
  expect(sendWhatsApp.mock.calls[0][0]).toEqual(sendWhatsApp.mock.calls[1][0]);
});

it("rechecks source authority after delayed identity resolution before uploading a local file", async () => {
  const store = state();
  process.env.INKBOX_OPENCODE_HOME = directories.at(-1)!;
  const path = join(directories.at(-1)!, "attachment.txt");
  writeFileSync(path, "attachment");
  store.saveTurn({
    id: "turn",
    messageID: "input",
    sessionID: "session",
    chatKey: "contact",
    state: "submitted",
    kind: "normal",
    text: "question",
    deliver: true,
    replyTarget: target,
    ownerId: "owner",
    leaseUntil: Date.now() + 10000,
    createdAt: 1,
    updatedAt: 1,
  });
  const upload = vi.fn();
  const deps: any = {
    runtime: {
      getIdentity: async () => {
        store.updateTurn("turn", { state: "interrupted" });
        return { id: owner, uploadWhatsAppMedia: upload };
      },
    },
    opencode: {
      session: {
        message: async () => ({ data: { info: { role: "assistant", parentID: "input" } } }),
      },
    },
  };
  const tool = whatsappTools(deps).find((tool) => tool.name === "inkbox_upload_whatsapp_media")!;
  try {
    await expect(
      tool.definition.execute({ mediaPath: path }, {
        sessionID: "session",
        messageID: "assistant",
        directory: "/tmp",
        ask: async () => {},
        abort: new AbortController().signal,
      } as any),
    ).rejects.toThrow("no longer owns");
    expect(upload).not.toHaveBeenCalled();
  } finally {
    delete process.env.INKBOX_OPENCODE_HOME;
  }
});

it.each([
  ["+15555550101", false],
  ["+15555550101", true],
  [" +1 (555) 555-0101 ", false],
  [" +1 (555) 555-0101 ", true],
  [["+15555550101"], false],
  [["+15555550101"], true],
  ["+15555550102", false],
])(
  "keeps explicit same-recipient delivery bound to the original final (%s, uncertain=%s)",
  async (to, uncertain) => {
    const store = state();
    vi.stubEnv("INKBOX_OPENCODE_HOME", directories.at(-1)!);
    store.saveTurn({
      id: "turn",
      messageID: "input",
      sessionID: "session",
      chatKey: "contact",
      state: "submitted",
      kind: "normal",
      text: "question",
      deliver: true,
      replyTarget: target,
      ownerId: "owner",
      leaseUntil: Date.now() + 10000,
      createdAt: 1,
      updatedAt: 1,
    });
    const send = vi.fn(async () => {
      if (uncertain) throw new TypeError("response lost");
      return { id: source, conversationId: conversation };
    });
    const deps: any = {
      runtime: { getIdentity: async () => ({ id: owner, sendWhatsApp: send }) },
      config: { outbound: { approval: "auto", allowedRecipients: [] } },
      opencode: {
        session: {
          message: async () => ({ data: { info: { role: "assistant", parentID: "input" } } }),
        },
      },
    };
    const tool = whatsappTools(deps).find((item) => item.name === "inkbox_send_whatsapp")!;
    const operation = tool.definition.execute({ to, text: "Saved answer" }, {
      sessionID: "session",
      messageID: "assistant",
      directory: "/tmp",
      abort: new AbortController().signal,
    } as any);
    if (uncertain) await expect(operation).rejects.toThrow("not confirmed");
    else await operation;
    expect(send).toHaveBeenCalledOnce();
    expect(hasExplicitWhatsAppReply(target, store)).toBe(to !== "+15555550102");
  },
);

function v2Tools(allowedRecipients: string[] = []) {
  state();
  vi.stubEnv("INKBOX_OPENCODE_HOME", directories.at(-1)!);
  const identity: any = {
    id: owner,
    getWhatsAppConversation: vi.fn(async () => ({
      agentIdentityId: owner,
      isGroup: true,
      participants: ["+15555550101", "+15555550102"],
      unresolvedParticipantCount: 0,
    })),
    getWhatsAppMessage: vi.fn(async () => ({
      agentIdentityId: owner,
      conversationId: conversation,
    })),
    getWhatsAppReaction: vi.fn(async () => ({ targetMessageId: source })),
    sendWhatsApp: vi.fn(async () => ({
      id: "accepted",
      conversationId: conversation,
      status: "queued",
    })),
    sendWhatsAppReaction: vi.fn(async () => ({
      reaction: { id: "reaction", status: "queued", revision: 1 },
    })),
    removeWhatsAppReaction: vi.fn(async () => ({
      reaction: { id: "reaction", status: "removed" },
    })),
    getWhatsAppThread: vi.fn(async () => ({
      conversationId: conversation,
      threadId: null,
      threadRootMessageId: null,
      messages: [],
      nextCursor: null,
    })),
  };
  const ctx: any = {
    sessionID: "test-session",
    messageID: "assistant",
    directory: "/tmp",
    ask: vi.fn(async () => {}),
    abort: new AbortController().signal,
  };
  const tools = whatsappTools({
    runtime: { getIdentity: async () => identity },
    config: { outbound: { approval: "auto", allowedRecipients, askTimeoutMs: 100 } },
  } as any);
  return {
    identity,
    ctx,
    tools,
    execute: (name: string, args: any) =>
      tools.find((tool) => tool.name === `inkbox_${name}`)!.definition.execute(args, ctx),
  };
}
it("supports group creation and explicit quotes while enforcing every participant permission", async () => {
  const f = v2Tools(["+15555550101", "+15555550102"]);
  expect(f.tools).toHaveLength(15);
  await f.execute("send_whatsapp", {
    to: ["+1 (555)555-0101", "+15555550102"],
    groupName: "Team",
    text: "Hello",
    idempotencyKey: "group-key",
  });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledWith({
    to: ["+15555550101", "+15555550102"],
    groupName: "Team",
    text: "Hello",
    idempotencyKey: "group-key",
  });
  await f.execute("send_whatsapp", {
    conversationId: conversation,
    replyToMessageId: source,
    text: "Quoted",
    idempotencyKey: "quote-key",
  });
  expect(f.identity.sendWhatsApp.mock.calls[1][0]).toEqual({
    conversationId: conversation,
    replyToMessageId: source,
    text: "Quoted",
    idempotencyKey: "quote-key",
  });
  for (const to of [
    ["+15555550101", "+15555550103"],
    ["+15555550101", "+1 (555)555-0101"],
    ["123@g.us"],
  ])
    await expect(f.execute("send_whatsapp", { to, text: "Blocked" })).rejects.toThrow();
  await expect(
    f.execute("send_whatsapp", { to: "+15555550101", replyToMessageId: source, text: "Bad" }),
  ).rejects.toThrow("requires conversationId");
  expect(f.identity.sendWhatsApp).toHaveBeenCalledTimes(2);
});
it("addresses larger existing groups by ID and rejects unresolved or foreign conversation targets", async () => {
  const f = v2Tools();
  f.identity.getWhatsAppConversation.mockResolvedValue({
    agentIdentityId: owner,
    isGroup: true,
    participants: Array.from({ length: 10 }, (_, i) => `+15555550${String(120 + i)}`),
  });
  await f.execute("send_whatsapp", {
    conversationId: conversation,
    text: "All",
    idempotencyKey: "large-group",
  });
  expect(f.identity.sendWhatsApp.mock.calls[0][0]).not.toHaveProperty("to");
  for (const change of [{ agentIdentityId: "foreign" }, { unresolvedParticipantCount: 1 }]) {
    f.identity.getWhatsAppConversation.mockResolvedValue({
      agentIdentityId: owner,
      participants: ["+15555550101"],
      ...change,
    });
    await expect(
      f.execute("send_whatsapp", {
        conversationId: conversation,
        text: "Blocked",
        idempotencyKey: "blocked",
      }),
    ).rejects.toThrow("resolved conversation");
  }
  expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
});
it("retains explicit quote and destination identity across lost-response retries instead of issuing a new send", async () => {
  const store = state(),
    sendWhatsApp = vi.fn().mockRejectedValue(new TypeError("timeout")),
    identity: any = { id: owner, sendWhatsApp };
  const payload = { text: "Quoted", replyToMessageId: source };
  await expect(
    (await prepareWhatsApp(identity, target, payload, store, "original-quote"))(),
  ).rejects.toThrow("original-quote");
  await expect(
    (await prepareWhatsApp(identity, target, payload, store, "original-quote"))(),
  ).rejects.toThrow("outcome is unconfirmed");
  await expect(
    (
      await prepareWhatsApp(
        identity,
        target,
        { ...payload, replyToMessageId: "another" },
        store,
        "original-quote",
      )
    )(),
  ).rejects.toThrow("different payload");
  expect(sendWhatsApp).toHaveBeenCalledOnce();
});
it("preserves reaction receipts and exact keys without claiming queued means applied", async () => {
  const f = v2Tools();
  f.identity.sendWhatsAppReaction.mockRejectedValueOnce(new TypeError("timeout"));
  const args = { messageId: source, reaction: "eyes", idempotencyKey: "reaction-key" };
  await expect(f.execute("send_whatsapp_reaction", args)).rejects.toThrow("reaction-key");
  expect(await f.execute("send_whatsapp_reaction", args)).toContain('"queued"');
  expect(f.identity.sendWhatsAppReaction.mock.calls[0][0]).toEqual(
    f.identity.sendWhatsAppReaction.mock.calls[1][0],
  );
  await f.execute("remove_whatsapp_reaction", {
    reactionId: "reaction",
    idempotencyKey: "remove-key",
  });
  expect(f.identity.removeWhatsAppReaction).toHaveBeenCalledWith("reaction", "remove-key");
  await expect(f.execute("send_whatsapp_reaction", { ...args, customEmoji: "👀" })).rejects.toThrow(
    "Specify reaction or customEmoji",
  );
  expect(f.identity.sendWhatsAppReaction).toHaveBeenCalledTimes(2);
});

async function reactionSdkTools() {
  const f = v2Tools();
  const receipt = JSON.parse(
    readFileSync(new URL("../fixtures/whatsapp-v2.json", import.meta.url), "utf8"),
  ).uncertain_reaction;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => ok({ reaction: receipt }, 201));
  fetch.mockResolvedValueOnce(ok(identityWire));
  vi.stubGlobal("fetch", fetch);
  const { identity } = await realIdentity();
  fetch.mockClear();
  f.identity.sendWhatsAppReaction = vi.fn(identity.sendWhatsAppReaction.bind(identity));
  f.identity.removeWhatsAppReaction = vi.fn(identity.removeWhatsAppReaction.bind(identity));
  return { ...f, fetch };
}

it("rejects local emoji errors without intent and allows one corrected same-key SDK write", async () => {
  const f = await reactionSdkTools();
  const args = { messageId: source, customEmoji: "thumbs up", idempotencyKey: "correctable" };
  await expect(f.execute("send_whatsapp_reaction", args)).rejects.toThrow("customEmoji");
  expect(createStateStore().read().whatsappSends ?? {}).toEqual({});
  expect(f.identity.sendWhatsAppReaction).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.identity.getWhatsAppMessage).not.toHaveBeenCalled();
  expect(f.ctx.ask).not.toHaveBeenCalled();
  const corrected = { ...args, customEmoji: "👍" };
  expect(await f.execute("send_whatsapp_reaction", corrected)).toContain('"uncertain"');
  await f.execute("send_whatsapp_reaction", corrected);
  expect(f.identity.sendWhatsAppReaction).toHaveBeenCalledExactlyOnceWith(corrected);
  expect(f.fetch).toHaveBeenCalledOnce();
  const request = f.fetch.mock.calls[0][1];
  expect(JSON.parse(String(request?.body))).toEqual({ message_id: source, custom_emoji: "👍" });
  expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(args.idempotencyKey);
});

it.each([false, true])(
  "rejects invalid reaction keys before intent or I/O (remove: %s)",
  async (remove) => {
    const f = await reactionSdkTools();
    for (const idempotencyKey of ["k".repeat(256), "", " \t", "😀".repeat(128)]) {
      await expect(
        f.execute(remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction", {
          messageId: source,
          reaction: "eyes",
          reactionId: "revision-1",
          idempotencyKey,
        }),
      ).rejects.toThrow("stable idempotencyKey");
      expect(createStateStore().read().whatsappSends ?? {}).toEqual({});
    }
    expect(f.identity.sendWhatsAppReaction).not.toHaveBeenCalled();
    expect(f.identity.removeWhatsAppReaction).not.toHaveBeenCalled();
    expect(f.identity.getWhatsAppReaction).not.toHaveBeenCalled();
    expect(f.identity.getWhatsAppMessage).not.toHaveBeenCalled();
    expect(f.identity.getWhatsAppConversation).not.toHaveBeenCalled();
    expect(f.ctx.ask).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);

it.each([
  { messageId: "not-a-uuid", reaction: "eyes" },
  { messageId: `${source}x`, reaction: "eyes" },
  { messageId: source, reaction: "unsupported" },
  { messageId: source, customEmoji: "" },
  { messageId: source, customEmoji: "👍".repeat(33) },
  { messageId: source, customEmoji: "👍\u0000" },
  { messageId: source, customEmoji: "👍\ud800" },
  { messageId: source, customEmoji: "👍\u00a0" },
])("rejects invalid reaction input before intent or I/O: %j", async (input) => {
  const f = await reactionSdkTools();
  await expect(
    f.execute("send_whatsapp_reaction", { ...input, idempotencyKey: "invalid-input" }),
  ).rejects.toThrow();
  expect(createStateStore().read().whatsappSends ?? {}).toEqual({});
  expect(f.identity.sendWhatsAppReaction).not.toHaveBeenCalled();
  expect(f.identity.getWhatsAppMessage).not.toHaveBeenCalled();
  expect(f.identity.getWhatsAppConversation).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});

it("accepts SDK reaction boundaries without trimming or enforcing UUID version bits", async () => {
  const f = await reactionSdkTools();
  const args = {
    messageId: "ABCDEF12-3456-0000-0000-ABCDEF123456",
    customEmoji: "👍".repeat(32),
    idempotencyKey: ` ${"k".repeat(253)} `,
  };
  const schema = f.tools.find((tool) => tool.name === "inkbox_send_whatsapp_reaction")?.definition
    .args.customEmoji;
  if (!schema) throw new Error("Missing reaction schema");
  expect(z.safeParse(schema, args.customEmoji).success).toBe(true);
  await f.execute("send_whatsapp_reaction", args);
  expect(f.identity.sendWhatsAppReaction).toHaveBeenCalledExactlyOnceWith(args);
  const request = f.fetch.mock.calls[0][1];
  expect(JSON.parse(String(request?.body))).toEqual({
    message_id: args.messageId,
    custom_emoji: args.customEmoji,
  });
  // The SDK receives the original key; HTTP Headers performs its own whitespace normalization.
  expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(args.idempotencyKey.trim());
});

it.each([false, true])(
  "fences a post-accept SDK decode failure and replays exactly (remove: %s)",
  async (remove) => {
    const f = await reactionSdkTools();
    const tool = remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction";
    const args = remove
      ? { reactionId: "revision-1", idempotencyKey: "decode-key" }
      : { messageId: source, customEmoji: "👍", idempotencyKey: "decode-key" };
    f.fetch.mockResolvedValueOnce(ok({}, 201));
    await expect(f.execute(tool, args)).rejects.toThrow("not confirmed");
    const started = createStateStore().read().whatsappSends;
    expect(Object.values(started as object)).toEqual([
      expect.objectContaining({ state: "started", idempotencyKey: args.idempotencyKey }),
    ]);
    await expect(
      f.execute(
        tool,
        remove ? { ...args, reactionId: "revision-2" } : { ...args, customEmoji: "👀" },
      ),
    ).rejects.toThrow("different operation");
    expect(createStateStore().read().whatsappSends).toEqual(started);
    expect(f.fetch).toHaveBeenCalledOnce();
    await f.execute(tool, args);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const requests = f.fetch.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: init?.body,
      headers: Object.fromEntries(new Headers(init?.headers)),
    }));
    expect(requests[1]).toEqual(requests[0]);
    await f.execute(tool, args);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  },
);
it("reads nullable unthreaded envelopes without inventing thread IDs", async () => {
  const f = v2Tools();
  expect(await f.execute("get_whatsapp_thread", { messageId: source, limit: 50 })).toContain(
    '"threadId": null',
  );
  expect(f.identity.getWhatsAppThread).toHaveBeenCalledWith(source, {
    limit: 50,
    cursor: undefined,
  });
});
it("routes group messages and peer reactions by conversation while checking the actual author", async () => {
  const handleInbound = vi.fn(),
    chatKeyFor = vi.fn((input) => input.contactId ?? `group:${input.conversationId}`);
  const deps: any = {
    config: { gateway: { ...defaultGatewayConfig(), allowAllUsers: true } },
    inkbox: { getIdentity: async () => ({ id: owner }) },
    contacts: { resolve: vi.fn(async () => ({ contactId: "same-contact" })), chatKeyFor },
    sessions: { handleInbound },
    state: state(),
    notify: createNotifyOnce(),
    logger,
  };
  const message = {
    ...wire,
    remote_number: null,
    reply_to_message_id: "quote-parent",
    thread_id: "quote-thread",
    thread_root_message_id: "quote-root",
    is_group: true,
    direction: "inbound",
    sender_number: "+15555550101",
    participants: ["+15555550101", "+15555550102"],
  };
  const e: any = {
    provider: "inkbox",
    verified: true,
    eventType: "whatsapp.received",
    body: { data: { message } },
    headers: {},
  };
  await dispatchEvent(deps, e);
  expect(handleInbound.mock.calls[0][0]).toMatchObject({
    chatKey: `group:${conversation}`,
    group: { participantCount: 2 },
    whatsappSource: {
      parentMessageId: "quote-parent",
      threadId: "quote-thread",
      rootMessageId: "quote-root",
    },
    from: "+15555550101",
  });
  const reaction = {
    id: "reaction-1",
    revision: 1,
    agent_identity_id: owner,
    conversation_id: conversation,
    target_message_id: source,
    direction: "inbound",
    remote_number: "+15555550102",
    status: "applied",
    emoji: "👀",
  };
  await dispatchEvent(deps, {
    ...e,
    eventType: "whatsapp.reaction_received",
    body: { data: { message: { ...message, direction: "outbound" }, reaction } },
  });
  expect(handleInbound.mock.calls[1][0]).toMatchObject({
    messageId: "reaction:reaction-1:1:applied",
    chatKey: `group:${conversation}`,
    reaction: true,
    from: "+15555550102",
  });
  expect(handleInbound.mock.calls[1][0].text).toContain("context, not a new instruction");
  await dispatchEvent(deps, {
    ...e,
    eventType: "whatsapp.reaction_received",
    body: { data: { message, reaction: { ...reaction, direction: "outbound" } } },
  });
  await dispatchEvent(deps, {
    ...e,
    body: { data: { message: { ...message, sender_number: null } } },
  });
  await dispatchEvent(deps, {
    ...e,
    eventType: "whatsapp.reaction_received",
    body: { data: { message: { ...message, is_blocked: true }, reaction } },
  });
  expect(handleInbound).toHaveBeenCalledTimes(2);
  await dispatchEvent(deps, {
    ...e,
    eventType: "whatsapp.reaction_received",
    body: { data: { message, reaction: { ...reaction, revision: 2, status: "removed" } } },
  });
  expect(handleInbound.mock.calls[2][0]).toMatchObject({
    messageId: "reaction:reaction-1:2:removed",
    reaction: true,
  });
});

it.each(["whatsapp_new_group_limit", "whatsapp_group_unanswered_limit"])(
  "curates the exact server group-policy rejection %s",
  (code) => {
    expect(
      publicWhatsAppPolicy(
        new InkboxAPIError(429, {
          error: code,
          quota: "whatsapp.groups_per_24h",
          limit: 5,
          private_detail: "not-public",
        }),
      ),
    ).toEqual({ error: code, quota: "whatsapp.groups_per_24h", limit: 5, status_code: 429 });
  },
);
it("checks every group peer before a reaction write", async () => {
  const f = v2Tools(["+15555550101"]);
  await expect(
    f.execute("send_whatsapp_reaction", {
      messageId: source,
      reaction: "eyes",
      idempotencyKey: "blocked-key",
    }),
  ).rejects.toThrow("not on the outbound allowlist");
  expect(f.identity.sendWhatsAppReaction).not.toHaveBeenCalled();
});

it("uses the canonical complete-target reaction webhook and ignores unresolved actors", async () => {
  const shared = JSON.parse(
    readFileSync(new URL("../fixtures/whatsapp-v2.json", import.meta.url), "utf8"),
  );
  const handleInbound = vi.fn(),
    deps: any = {
      config: { gateway: { ...defaultGatewayConfig(), allowAllUsers: true } },
      inkbox: { getIdentity: async () => ({ id: shared.message.agent_identity_id }) },
      contacts: { resolve: async () => ({ contactId: "contact" }), chatKeyFor: () => "contact" },
      sessions: { handleInbound },
      state: state(),
      notify: createNotifyOnce(),
      logger,
    };
  const raw = structuredClone(shared.reaction_webhook),
    e: any = {
      provider: "inkbox",
      verified: true,
      eventType: raw.event_type,
      body: raw,
      headers: {},
    };
  await dispatchEvent(deps, e);
  expect(handleInbound).not.toHaveBeenCalled();
  raw.data.reaction.remote_number = shared.message.participants[0];
  await dispatchEvent(deps, e);
  expect(handleInbound).toHaveBeenCalledOnce();
  expect(handleInbound.mock.calls[0][0].text).toContain("context, not a new instruction");
  expect(handleInbound.mock.calls[0][0].text).not.toContain(shared.message.content);
});

it.each(["", " ", "\n", null])(
  "rejects an explicit invalid quote instead of sending plain: %j",
  async (replyToMessageId) => {
    const f = v2Tools();
    await expect(
      f.execute("send_whatsapp", {
        conversationId: conversation,
        replyToMessageId,
        text: "Never plain",
      }),
    ).rejects.toThrow("nonempty message ID");
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  },
);

it.each(["started", "sent", "rejected"])(
  "preserves a legacy plain payload and hash across restart (%s)",
  async (status) => {
    const store = state(),
      payload = { text: "Legacy answer" };
    const key = `opencode:whatsapp:${createHash("sha256")
      .update(JSON.stringify([owner, conversation, source, payload]))
      .digest("hex")}`;
    const saved = {
      identityId: owner,
      sourceId: source,
      conversationId: conversation,
      explicit: false,
      payload: JSON.stringify(payload),
      idempotencyKey: key,
      state: status,
      ...(status === "sent" ? { messageId: "accepted" } : {}),
    };
    store.updateWhatsAppSend(key, () => saved);
    const identity: any = { id: owner, sendWhatsApp: vi.fn(async () => ({ id: "accepted" })) };
    const restarted = createStateStore(directories.at(-1)!);
    const send = await prepareReply(
      { getIdentity: async () => identity } as any,
      target,
      payload.text,
      logger,
      restarted,
    );
    if (status === "started") await expect(send()).rejects.toThrow("unconfirmed");
    else await send();
    if (status === "rejected")
      expect(identity.sendWhatsApp).toHaveBeenCalledWith({
        ...payload,
        conversationId: conversation,
        idempotencyKey: key,
      });
    else expect(identity.sendWhatsApp).not.toHaveBeenCalled();
    const rows = restarted.read().whatsappSends as Record<string, any>;
    expect(Object.keys(rows)).toEqual([key]);
    expect(rows[key].payload).toBe(JSON.stringify(payload));
  },
);

it.each([false, true])(
  "anchors a new ordinary reply to its source, not its quoted parent (group=%s)",
  async (group) => {
    const store = state();
    const identity: any = {
      id: owner,
      sendWhatsApp: vi.fn(async () => ({ id: "accepted" })),
      getWhatsAppConversation: vi.fn(async () => ({
        agentIdentityId: owner,
        isGroup: true,
        participants: ["+15555550101", "+15555550102"],
      })),
    };
    const route = {
      ...target,
      group,
      whatsappSource: { ...target.whatsappSource, parentMessageId: "earlier-parent" },
    };
    await (
      await prepareReply(
        { getIdentity: async () => identity } as any,
        route,
        "New answer",
        logger,
        store,
      )
    )();
    expect(identity.sendWhatsApp).toHaveBeenCalledWith({
      text: "New answer",
      conversationId: conversation,
      replyToMessageId: source,
      idempotencyKey: expect.any(String),
    });
  },
);

it("never treats a reaction receipt or unproven reaction target as a quote", async () => {
  const identity: any = { id: owner, sendWhatsApp: vi.fn(async () => ({ id: "accepted" })) };
  await (
    await prepareWhatsApp(
      identity,
      {
        ...target,
        whatsappSource: {
          ...target.whatsappSource,
          messageId: "reaction:receipt:1",
          reactionId: "receipt",
          targetMessageId: "unproven-target",
        },
      },
      { text: "Noted" },
      state(),
    )
  )();
  expect(identity.sendWhatsApp.mock.calls[0][0]).not.toHaveProperty("replyToMessageId");
});

it.each([false, true])(
  "fences new replacement intents after an explicit quoted attempt (rejected=%s)",
  async (rejected) => {
    const store = state(),
      identity: any = {
        id: owner,
        sendWhatsApp: vi.fn(async () => {
          if (rejected) throw new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" });
          throw new TypeError("response lost");
        }),
      };
    await expect(
      (
        await prepareWhatsApp(
          identity,
          target,
          { text: "Answer", replyToMessageId: "44444444-4444-4444-8444-444444444444" },
          store,
          "quote-key",
        )
      )(),
    ).rejects.toThrow();
    await expect(
      (await prepareWhatsApp(identity, target, { text: "Replacement" }, store, "new-key", false))(),
    ).rejects.toThrow("unresolved quoted send");
    expect(identity.sendWhatsApp).toHaveBeenCalledOnce();
    expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
  },
);

it("keeps an old persisted source without quote admission plain", async () => {
  const old = { ...target, whatsappSource: { messageId: source, identityId: owner } };
  const identity: any = { id: owner, sendWhatsApp: vi.fn(async () => ({ id: "accepted" })) };
  await (await prepareWhatsApp(identity, old, { text: "Saved answer" }, state()))();
  expect(identity.sendWhatsApp.mock.calls[0][0]).not.toHaveProperty("replyToMessageId");
});

it.each([false, true])(
  "defaults source-owned tools without retargeting explicit outreach (group=%s)",
  async (group) => {
    const store = state();
    vi.stubEnv("INKBOX_OPENCODE_HOME", directories.at(-1)!);
    store.saveTurn({
      id: "owned-turn",
      messageID: "input",
      sessionID: "session",
      chatKey: "contact",
      state: "submitted",
      kind: "normal",
      text: "question",
      deliver: true,
      replyTarget: { ...target, group },
      ownerId: "owner",
      leaseUntil: Date.now() + 60000,
      createdAt: 1,
      updatedAt: 1,
    });
    const identity: any = {
      id: owner,
      sendWhatsApp: vi.fn(async () => ({ id: "accepted" })),
      getWhatsAppConversation: vi.fn(async () => ({
        agentIdentityId: owner,
        isGroup: group,
        participants: group ? ["+15555550101", "+15555550102"] : ["+15555550101"],
      })),
    };
    const tool = whatsappTools({
      runtime: { getIdentity: async () => identity },
      config: { outbound: { approval: "auto", allowedRecipients: [] } },
      opencode: {
        session: {
          message: async () => ({
            data: {
              info: {
                role: "assistant",
                parentID: "input",
              },
            },
          }),
        },
      },
    } as any).find((item) => item.name === "inkbox_send_whatsapp")!;
    const ctx: any = {
      sessionID: "session",
      messageID: "assistant",
      directory: "/tmp",
      abort: new AbortController().signal,
    };
    await tool.definition.execute({ text: "Source answer" }, ctx);
    expect(identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({
      conversationId: conversation,
      replyToMessageId: source,
      text: "Source answer",
    });
    expect(hasExplicitWhatsAppReply(target, store)).toBe(true);
    await tool.definition.execute({ to: "+15555550103", text: "Outreach" }, ctx);
    expect(identity.sendWhatsApp.mock.calls[1][0]).toMatchObject({ to: "+15555550103" });
    expect(identity.sendWhatsApp.mock.calls[1][0]).not.toHaveProperty("replyToMessageId");
    await tool.definition.execute(
      { conversationId: "another-conversation", text: "Other room" },
      ctx,
    );
    expect(identity.sendWhatsApp.mock.calls[2][0]).toMatchObject({
      conversationId: "another-conversation",
    });
    expect(identity.sendWhatsApp.mock.calls[2][0]).not.toHaveProperty("replyToMessageId");
    await tool.definition.execute(
      { text: "Legacy recovery", idempotencyKey: "unknown-old-key" },
      ctx,
    );
    expect(identity.sendWhatsApp.mock.calls[3][0]).not.toHaveProperty("replyToMessageId");
    store.updateTurn("owned-turn", { state: "interrupted" });
    await expect(tool.definition.execute({ text: "Cancelled" }, ctx)).rejects.toThrow(
      "no longer owns",
    );
    expect(identity.sendWhatsApp).toHaveBeenCalledTimes(4);
  },
);

it("restores an exact saved explicit quote on key-only retry without replacing its target", async () => {
  const store = state();
  const identity: any = {
    id: owner,
    sendWhatsApp: vi
      .fn()
      .mockRejectedValueOnce(new InkboxAPIError(409, { error: "whatsapp_quote_unavailable" }))
      .mockResolvedValue({ id: "accepted" }),
  };
  await expect(
    (
      await prepareWhatsApp(
        identity,
        target,
        { text: "Answer", replyToMessageId: "55555555-5555-4555-8555-555555555555" },
        store,
        "chosen-key",
      )
    )(),
  ).rejects.toThrow();
  await (await prepareWhatsApp(identity, target, { text: "Answer" }, store, "chosen-key", false))();
  expect(identity.sendWhatsApp.mock.calls[0][0]).toEqual(identity.sendWhatsApp.mock.calls[1][0]);
  expect(identity.sendWhatsApp.mock.calls[1][0].replyToMessageId).toBe(
    "55555555-5555-4555-8555-555555555555",
  );
});

it.each([false, true])(
  "retains reaction policy and immutable original operations (remove: %s)",
  async (remove) => {
    const f = v2Tools();
    const method = remove ? f.identity.removeWhatsAppReaction : f.identity.sendWhatsAppReaction;
    const tool = remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction";
    const args = remove
      ? { reactionId: "revision-1", idempotencyKey: "policy-key" }
      : { messageId: source, reaction: "eyes", idempotencyKey: "policy-key" };
    method.mockRejectedValueOnce(
      new InkboxAPIError(409, {
        error: "whatsapp_reaction_target_unavailable",
        diagnostic: "not-public",
      }),
    );
    expect(await f.execute(tool, args)).toBe(
      formatJson({
        error: "whatsapp_reaction_target_unavailable",
        status_code: 409,
        idempotencyKey: "policy-key",
      }),
    );
    const changed = remove ? { ...args, reactionId: "revision-2" } : { ...args, reaction: "love" };
    await expect(f.execute(tool, changed)).rejects.toThrow("different operation");
    expect(method).toHaveBeenCalledOnce();
    // An explicitly new operation is independent of an earlier definitive rejection.
    await f.execute(tool, { ...changed, idempotencyKey: "new-operation" });
    await f.execute(tool, args);
    expect(method).toHaveBeenCalledTimes(3);
    await f.execute(tool, args);
    expect(method).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  "retains uncertain reaction keys across tool reconstruction (remove: %s)",
  async (remove) => {
    const f = v2Tools();
    const method = remove ? f.identity.removeWhatsAppReaction : f.identity.sendWhatsAppReaction;
    const tool = remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction";
    const args = remove
      ? { reactionId: "revision-1", idempotencyKey: "uncertain-key" }
      : { messageId: source, reaction: "eyes", idempotencyKey: "uncertain-key" };
    method.mockRejectedValueOnce(new TypeError("lost response"));
    await expect(f.execute(tool, args)).rejects.toThrow("uncertain-key");
    expect(method).toHaveBeenCalledOnce();
    const started = createStateStore().read().whatsappSends;
    expect(Object.values(started as object)).toEqual([
      expect.objectContaining({
        state: "started",
        idempotencyKey: args.idempotencyKey,
        operation: JSON.stringify(
          remove ? { remove: args.reactionId } : { messageId: source, reaction: "eyes" },
        ),
      }),
    ]);
    if (!remove) {
      await expect(
        f.execute(tool, {
          messageId: source,
          customEmoji: "thumbs up",
          idempotencyKey: args.idempotencyKey,
        }),
      ).rejects.toThrow("customEmoji");
      expect(createStateStore().read().whatsappSends).toEqual(started);
    }
    const tools = whatsappTools({
      runtime: { getIdentity: async () => f.identity },
      config: { outbound: { approval: "auto", allowedRecipients: [] } },
    } as any);
    const execute = (input: any) =>
      tools.find((item) => item.name === `inkbox_${tool}`)!.definition.execute(input, f.ctx);
    await expect(
      execute(remove ? { ...args, reactionId: "revision-2" } : { ...args, reaction: "love" }),
    ).rejects.toThrow("different operation");
    expect(createStateStore().read().whatsappSends).toEqual(started);
    expect(method).toHaveBeenCalledOnce();
    await execute(args);
    expect(method).toHaveBeenCalledTimes(2);
    expect(method.mock.calls[1]).toEqual(method.mock.calls[0]);
    await execute(args);
    expect(method).toHaveBeenCalledTimes(2);
    const opposite = remove ? "send_whatsapp_reaction" : "remove_whatsapp_reaction";
    await expect(
      f.execute(
        opposite,
        remove
          ? { messageId: source, reaction: "eyes", idempotencyKey: args.idempotencyKey }
          : { reactionId: "revision-1", idempotencyKey: args.idempotencyKey },
      ),
    ).rejects.toThrow("different operation");
  },
);

it.each([401, 403, 404, 410])(
  "handles unavailable attachment status %s without losing authorized text",
  async (statusCode) => {
    const store = state();
    const handleInbound = vi.fn();
    const failure = Object.assign(new Error("media unavailable"), { statusCode });
    const deps: any = {
      config: { gateway: { ...defaultGatewayConfig(), allowAllUsers: true } },
      inkbox: {
        getIdentity: async () => ({
          id: owner,
          getWhatsAppMedia: async () => {
            throw failure;
          },
        }),
      },
      contacts: { resolve: async () => ({ contactId: "contact" }), chatKeyFor: () => "contact" },
      sessions: { handleInbound },
      state: store,
      notify: createNotifyOnce(),
      logger,
    };
    const event: any = {
      provider: "inkbox",
      verified: true,
      eventType: "whatsapp.received",
      headers: {},
      body: {
        data: {
          message: {
            ...wire,
            direction: "inbound",
            sender_number: "+15555550101",
            status: "received",
            media: [{ id: "owned-media" }],
          },
        },
      },
    };
    if (statusCode === 401) {
      await expect(dispatchEvent(deps, event)).rejects.toBe(failure);
      expect(handleInbound).not.toHaveBeenCalled();
    } else {
      await dispatchEvent(deps, event);
      expect(handleInbound).toHaveBeenCalledOnce();
      expect(handleInbound.mock.calls[0][0]).toMatchObject({
        text: expect.stringContaining("Saved answer"),
        mediaPaths: [],
      });
      expect(handleInbound.mock.calls[0][0].text).toContain("attachment unavailable");
    }
  },
);
