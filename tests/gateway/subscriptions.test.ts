import { InkboxAPIError } from "@inkbox/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import {
  A2A_EVENT_TYPES,
  IDENTITY_EVENT_TYPES,
  IMESSAGE_EVENT_TYPES,
  MAILBOX_EVENT_TYPES,
  PHONE_EVENT_TYPES,
  reconcileSubscriptions,
} from "../../src/gateway/subscriptions.js";
import type { GatewayDeps, GatewayLogger } from "../../src/gateway/types.js";

const PUBLIC_URL = "https://scout.tunnel.inkbox.ai";
const WEBHOOK_URL = `${PUBLIC_URL}/webhook`;
const MEDIA_WS_URL = "wss://scout.tunnel.inkbox.ai/phone/media/ws";

interface SubRow {
  id: string;
  mailboxId?: string;
  phoneNumberId?: string;
  agentIdentityId?: string;
  url: string;
  eventTypes: string[];
}

function makeSubscriptions(
  existing: SubRow[] = [],
  opts: { signingKeyOnFirstCreate?: string } = {},
) {
  let creates = 0;
  return {
    list: vi.fn(async (filters: Record<string, string | undefined>) =>
      existing.filter(
        (sub) =>
          (filters.mailboxId === undefined || sub.mailboxId === filters.mailboxId) &&
          (filters.phoneNumberId === undefined || sub.phoneNumberId === filters.phoneNumberId) &&
          (filters.agentIdentityId === undefined ||
            sub.agentIdentityId === filters.agentIdentityId),
      ),
    ),
    create: vi.fn(async (options: { url: string; eventTypes: string[] }) => {
      creates += 1;
      return {
        id: `sub-created-${creates}`,
        url: options.url,
        eventTypes: options.eventTypes,
        signingKey: creates === 1 ? (opts.signingKeyOnFirstCreate ?? null) : null,
      };
    }),
    update: vi.fn(async (subId: string, options: { eventTypes?: string[] }) => ({
      id: subId,
      ...options,
    })),
    delete: vi.fn(async () => {}),
  };
}

function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    id: "ident-1",
    agentHandle: "scout",
    imessageEnabled: true,
    mailbox: { id: "mb-1", emailAddress: "scout@agents.inkbox.ai" },
    phoneNumber: { id: "pn-1", number: "+15551230000" },
    setIncomingCallAction: vi.fn(async (options: Record<string, unknown>) => ({
      agentIdentityId: "ident-1",
      ...options,
    })),
    ...overrides,
  };
}

function makeDeps(
  identity: Record<string, unknown>,
  subscriptions: ReturnType<typeof makeSubscriptions>,
  options: { voiceEnabled?: boolean } = {},
): GatewayDeps & { logger: { [K in keyof GatewayLogger]: ReturnType<typeof vi.fn> } } {
  const client = { webhooks: { subscriptions } };
  const config = {
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    gateway: {
      enabled: true,
      mode: "sidecar",
      host: "127.0.0.1",
      port: 8767,
      allowedUsers: [],
      allowAllUsers: false,
      allowedInboundContactIds: [],
      requireSignature: true,
      externalEvents: false,
      outboundApproval: "allowlist",
      permissionTimeoutS: 600,
      voice: {
        enabled: options.voiceEnabled ?? false,
        realtime: {
          enabled: false,
          model: "gpt-realtime-2",
          voice: "cedar",
          apiKeyEnvVar: "INKBOX_REALTIME_API_KEY",
          fallbackToInkboxSttTts: true,
        },
      },
    },
  } as unknown as ResolvedConfig;
  return {
    inkbox: {
      getIdentity: vi.fn(async () => identity),
      getClient: vi.fn(async () => client),
    },
    opencode: {},
    config,
    state: {
      read: vi.fn(),
      update: vi.fn(),
      setSession: vi.fn(),
      getSession: vi.fn(),
      clearSession: vi.fn(),
      filePath: "/tmp/state.json",
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    directory: "/tmp/project",
  } as unknown as GatewayDeps & {
    logger: { [K in keyof GatewayLogger]: ReturnType<typeof vi.fn> };
  };
}

function allLoggedText(logger: { [K in keyof GatewayLogger]: ReturnType<typeof vi.fn> }): string {
  return JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
}

describe("reconcileSubscriptions", () => {
  it("creates mailbox, phone, and imessage subscriptions when none exist", async () => {
    const subs = makeSubscriptions();
    const result = await reconcileSubscriptions(makeDeps(makeIdentity(), subs), PUBLIC_URL);

    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(subs.create).toHaveBeenCalledTimes(3);
    expect(subs.create).toHaveBeenCalledWith({
      mailboxId: "mb-1",
      url: WEBHOOK_URL,
      eventTypes: MAILBOX_EVENT_TYPES,
    });
    expect(subs.create).toHaveBeenCalledWith({
      phoneNumberId: "pn-1",
      url: WEBHOOK_URL,
      eventTypes: PHONE_EVENT_TYPES,
    });
    expect(subs.create).toHaveBeenCalledWith({
      agentIdentityId: "ident-1",
      url: WEBHOOK_URL,
      eventTypes: IDENTITY_EVENT_TYPES,
    });
    expect(subs.update).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from the public URL before building the webhook URL", async () => {
    const subs = makeSubscriptions();
    await reconcileSubscriptions(makeDeps(makeIdentity(), subs), `${PUBLIC_URL}/`);

    for (const [options] of subs.create.mock.calls) {
      expect(options.url).toBe(WEBHOOK_URL);
    }
  });

  it("updates only the subscription whose event types differ", async () => {
    const subs = makeSubscriptions([
      { id: "sub-mb", mailboxId: "mb-1", url: WEBHOOK_URL, eventTypes: ["message.received"] },
      { id: "sub-pn", phoneNumberId: "pn-1", url: WEBHOOK_URL, eventTypes: PHONE_EVENT_TYPES },
      {
        id: "sub-im",
        agentIdentityId: "ident-1",
        url: WEBHOOK_URL,
        eventTypes: IDENTITY_EVENT_TYPES,
      },
    ]);
    const result = await reconcileSubscriptions(makeDeps(makeIdentity(), subs), PUBLIC_URL);

    expect(result).toEqual({ created: 0, updated: 1, unchanged: 2 });
    expect(subs.update).toHaveBeenCalledTimes(1);
    expect(subs.update).toHaveBeenCalledWith("sub-mb", { eventTypes: MAILBOX_EVENT_TYPES });
    expect(subs.create).not.toHaveBeenCalled();
  });

  it("leaves a subscription unchanged when event types match in a different order", async () => {
    const subs = makeSubscriptions([
      {
        id: "sub-mb",
        mailboxId: "mb-1",
        url: WEBHOOK_URL,
        eventTypes: [...MAILBOX_EVENT_TYPES].reverse(),
      },
    ]);
    const identity = makeIdentity({ phoneNumber: null, imessageEnabled: false });
    const result = await reconcileSubscriptions(makeDeps(identity, subs), PUBLIC_URL);

    expect(result).toEqual({ created: 1, updated: 0, unchanged: 1 });
    expect(subs.create).toHaveBeenCalledWith({
      agentIdentityId: "ident-1",
      url: WEBHOOK_URL,
      eventTypes: A2A_EVENT_TYPES,
    });
    expect(subs.update).not.toHaveBeenCalled();
  });

  it("never touches subscriptions pointing at other URLs", async () => {
    const subs = makeSubscriptions([
      {
        id: "sub-foreign-mb",
        mailboxId: "mb-1",
        url: "https://other.example.com/webhook",
        eventTypes: ["message.received"],
      },
      {
        id: "sub-foreign-pn",
        phoneNumberId: "pn-1",
        url: "https://crm.example.com/hooks/inkbox",
        eventTypes: ["text.received"],
      },
    ]);
    const result = await reconcileSubscriptions(makeDeps(makeIdentity(), subs), PUBLIC_URL);

    // Foreign subscriptions are ignored entirely; ours are created alongside.
    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(subs.update).not.toHaveBeenCalled();
    expect(subs.delete).not.toHaveBeenCalled();
  });

  it("skips the phone subscription when the identity has no phone number", async () => {
    const subs = makeSubscriptions();
    const identity = makeIdentity({ phoneNumber: null });
    const result = await reconcileSubscriptions(makeDeps(identity, subs), PUBLIC_URL);

    expect(result).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const owners = subs.create.mock.calls.map(([options]) => options);
    expect(owners.some((o: Record<string, unknown>) => "phoneNumberId" in o)).toBe(false);
    expect(subs.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: expect.anything() }),
    );
  });

  it("keeps the identity A2A subscription when iMessage is disabled", async () => {
    const subs = makeSubscriptions();
    const identity = makeIdentity({ imessageEnabled: false });
    const result = await reconcileSubscriptions(makeDeps(identity, subs), PUBLIC_URL);

    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0 });
    const owners = subs.create.mock.calls.map(([options]) => options);
    expect(owners).toContainEqual({
      agentIdentityId: "ident-1",
      url: WEBHOOK_URL,
      eventTypes: A2A_EVENT_TYPES,
    });
  });

  it("falls back to legacy identity events when the API rejects A2A event types", async () => {
    const subs = makeSubscriptions();
    subs.create.mockImplementation(async (options: { url: string; eventTypes: string[] }) => {
      if (options.eventTypes.some((eventType) => A2A_EVENT_TYPES.includes(eventType))) {
        throw new Error("event_type 'a2a.task.created' does not belong to any known channel");
      }
      return {
        id: "sub-created",
        url: options.url,
        eventTypes: options.eventTypes,
        signingKey: null,
      };
    });
    const deps = makeDeps(makeIdentity(), subs);

    const result = await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(result).toEqual({ created: 3, updated: 0, unchanged: 0 });
    expect(subs.create).toHaveBeenLastCalledWith({
      agentIdentityId: "ident-1",
      url: WEBHOOK_URL,
      eventTypes: IMESSAGE_EVENT_TYPES,
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not support A2A webhook events yet"),
    );
  });

  it("continues without an identity subscription when only A2A events are unsupported", async () => {
    const subs = makeSubscriptions();
    subs.create.mockImplementation(async (options: { url: string; eventTypes: string[] }) => {
      if (options.eventTypes.some((eventType) => A2A_EVENT_TYPES.includes(eventType))) {
        throw new InkboxAPIError(422, { detail: "a2a.task.created is not a valid event type" });
      }
      return {
        id: "sub-created",
        url: options.url,
        eventTypes: options.eventTypes,
        signingKey: null,
      };
    });
    const deps = makeDeps(makeIdentity({ imessageEnabled: false }), subs);

    const result = await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(result).toEqual({ created: 2, updated: 0, unchanged: 0 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping the A2A-only identity subscription"),
    );
  });

  it("does not touch the incoming-call action when voice is disabled", async () => {
    const identity = makeIdentity();
    await reconcileSubscriptions(
      makeDeps(identity, makeSubscriptions(), { voiceEnabled: false }),
      PUBLIC_URL,
    );

    expect(identity.setIncomingCallAction).not.toHaveBeenCalled();
  });

  it("points the incoming-call action at the gateway media WebSocket when voice is enabled", async () => {
    const identity = makeIdentity();
    await reconcileSubscriptions(
      makeDeps(identity, makeSubscriptions(), { voiceEnabled: true }),
      PUBLIC_URL,
    );

    expect(identity.setIncomingCallAction).toHaveBeenCalledTimes(1);
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: MEDIA_WS_URL,
      incomingCallWebhookUrl: WEBHOOK_URL,
    });
  });

  it("skips incoming-call wiring when voice is enabled but no line can receive calls", async () => {
    const identity = makeIdentity({ phoneNumber: null, imessageEnabled: false });
    const deps = makeDeps(identity, makeSubscriptions(), { voiceEnabled: true });
    await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(identity.setIncomingCallAction).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("returns the once-shown signing key without logging it", async () => {
    const key = "whsec_do_not_log_me_123";
    const subs = makeSubscriptions([], { signingKeyOnFirstCreate: key });
    const deps = makeDeps(makeIdentity(), subs);
    const result = await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(result.signingKey).toBe(key);
    const warns = deps.logger.warn.mock.calls.map((call) => String(call[0]));
    expect(warns.some((msg) => msg.includes("INKBOX_SIGNING_KEY"))).toBe(true);
    expect(allLoggedText(deps.logger)).not.toContain(key);
  });

  it("omits the signing key from the result when the API does not mint one", async () => {
    const result = await reconcileSubscriptions(
      makeDeps(makeIdentity(), makeSubscriptions()),
      PUBLIC_URL,
    );

    expect(result.signingKey).toBeUndefined();
  });

  it("rejects a public URL without an http(s) scheme", async () => {
    await expect(
      reconcileSubscriptions(makeDeps(makeIdentity(), makeSubscriptions()), "scout.example.com"),
    ).rejects.toThrow(/http\(s\)/);
  });
});
