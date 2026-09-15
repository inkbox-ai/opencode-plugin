import { describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import {
  A2A_EVENT_TYPES,
  CALL_EVENT_TYPES,
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
  options: {
    voiceEnabled?: boolean;
    phoneVoiceStack?: "inkbox_voice_ai" | "openai_realtime" | "inkbox_tts_stt";
    skipWebhookReconcile?: boolean;
  } = {},
): GatewayDeps & { logger: { [K in keyof GatewayLogger]: ReturnType<typeof vi.fn> } } {
  const client = { webhooks: { subscriptions } };
  const config = {
    phoneVoiceStack: options.phoneVoiceStack ?? "inkbox_tts_stt",
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
      skipWebhookReconcile: options.skipWebhookReconcile ?? false,
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
  it("creates one mixed identity subscription without channels", async () => {
    const subs = makeSubscriptions();
    const identity = makeIdentity({ mailbox: null, phoneNumber: null, imessageEnabled: false });
    const result = await reconcileSubscriptions(makeDeps(identity, subs), PUBLIC_URL);
    expect(result).toEqual({ created: 1, updated: 0, unchanged: 0 });
    expect(subs.create).toHaveBeenCalledWith({
      agentIdentityId: "ident-1",
      url: WEBHOOK_URL,
      eventTypes: [
        ...MAILBOX_EVENT_TYPES,
        ...PHONE_EVENT_TYPES,
        ...IMESSAGE_EVENT_TYPES,
        ...CALL_EVENT_TYPES,
        ...A2A_EVENT_TYPES,
      ].sort(),
    });
    expect(subs.delete).not.toHaveBeenCalled();
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

  it("points incoming calls at Voice AI and clears stale local callback URLs", async () => {
    const identity = makeIdentity();
    await reconcileSubscriptions(
      makeDeps(identity, makeSubscriptions(), {
        voiceEnabled: true,
        phoneVoiceStack: "inkbox_voice_ai",
      }),
      PUBLIC_URL,
    );

    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
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

  it("canonicalizes the URL, preserves its path, and drops credentials/query/fragment", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, makeSubscriptions(), { voiceEnabled: true });
    await reconcileSubscriptions(
      deps,
      "HTTPS://user:secret@EXAMPLE.COM/some/path/?key=secret#fragment",
    );
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://example.com/some/path/phone/media/ws",
      incomingCallWebhookUrl: "https://example.com/some/path/webhook",
    });
    expect(JSON.stringify(identity.setIncomingCallAction.mock.calls)).not.toContain("secret");
  });

  it.each(["https:/example.com", "ftp://example.com", "https://"])(
    "rejects a malformed or non-HTTP public URL: %s",
    async (publicUrl) => {
      await expect(
        reconcileSubscriptions(makeDeps(makeIdentity(), makeSubscriptions()), publicUrl),
      ).rejects.toThrow("Gateway public URL must be an http(s) URL");
    },
  );

  it("does not disclose credentials from an invalid configured public URL", async () => {
    const secret = "do-not-log-this-token";
    await expect(
      reconcileSubscriptions(
        makeDeps(makeIdentity(), makeSubscriptions()),
        `ftp://user:${secret}@example.com/path?key=${secret}`,
      ),
    ).rejects.not.toThrow(secret);
  });
});

describe("skipWebhookReconcile", () => {
  // Deployments that provision subscriptions ahead of time have a fixed
  // destination and a key that may not be allowed to change it, so writing on
  // every boot is redundant at best and fatal to startup at worst.
  const identity = {
    id: "identity-1",
    mailbox: { id: "mailbox-1" },
    phoneNumber: { id: "phone-1" },
    imessageEnabled: true,
  };

  it("touches no subscriptions when enabled", async () => {
    const subscriptions = makeSubscriptions();
    const deps = makeDeps(identity, subscriptions, { skipWebhookReconcile: true });

    const result = await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(result).toEqual({ created: 0, updated: 0, unchanged: 0 });
    expect(subscriptions.list).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it("names the URL it expects deliveries to reach", async () => {
    const deps = makeDeps(identity, makeSubscriptions(), { skipWebhookReconcile: true });

    await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(deps.logger.info).toHaveBeenCalledWith("subscriptions.skipped", {
      expectedUrl: WEBHOOK_URL,
    });
  });

  it("still reconciles when left at the default", async () => {
    const subscriptions = makeSubscriptions();
    const deps = makeDeps(identity, subscriptions);

    await reconcileSubscriptions(deps, PUBLIC_URL);

    expect(subscriptions.create).toHaveBeenCalled();
  });
});
