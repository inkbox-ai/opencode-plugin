import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox, InkboxAPIError } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
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
  whatsappSource: { messageId: source, identityId: owner },
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

it("uses the real SDK for stable plain replies without quoted-iMessage fields or duplicate sends", async () => {
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
  });
  expect(new Headers(posts[0].init?.headers).get("Idempotency-Key")).toContain(
    "opencode:whatsapp:",
  );
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
  expect(hasExplicitWhatsAppReply(target, store)).toBe(false);
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
  expect(hasExplicitWhatsAppReply(target, store)).toBe(false);
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
