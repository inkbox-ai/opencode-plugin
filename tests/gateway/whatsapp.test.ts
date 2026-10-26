import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

it("refreshes inbound owned media, preserves contact session convergence, and ignores groups/other owners/echoes/status-only events", async () => {
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
    { is_group: true },
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

it.each([403, 422, 429])(
  "does not free send fencing for an unrecognized public-looking error (%s)",
  async (status) => {
    const store = state();
    const error = new InkboxAPIError(status, { error: "whatsapp_unrecognized_policy" });
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
