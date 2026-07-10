// Event routing: channel selection, sender filtering (self/control/allowlist),
// reactions, deduped delivery-failure captures, external events, and media.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { defaultGatewayConfig } from "../../src/config.js";
import { createNotifyOnce } from "../../src/gateway/dedup.js";
import type { DispatchDeps } from "../../src/gateway/dispatch.js";
import { dispatchEvent } from "../../src/gateway/dispatch.js";
import { downloadMedia, mediaDir } from "../../src/gateway/media.js";
import type { VerifiedEvent } from "../../src/gateway/types.js";

vi.mock("../../src/gateway/media.js", () => ({
  downloadMedia: vi.fn(async () => ["/tmp/gw-media/file.png"]),
  mediaDir: vi.fn(() => "/tmp/gw-media"),
}));

function makeConfig(gateway: Record<string, unknown> = {}): ResolvedConfig {
  return { gateway: { ...defaultGatewayConfig(), ...gateway } } as unknown as ResolvedConfig;
}

function makeDeps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    config: makeConfig({ allowAllUsers: true }),
    inkbox: {
      getIdentity: vi.fn(async () => ({
        emailAddress: "me@agents.inkbox.ai",
        phoneNumber: { number: "+15550000000" },
      })),
      getClient: vi.fn(),
    } as never,
    contacts: {
      resolve: vi.fn(async () => ({ contactId: "c1", contactName: "Ada" })),
      chatKeyFor: vi.fn(() => "ck"),
    },
    sessions: {
      handleInbound: vi.fn(async () => {}),
      runCapture: vi.fn(async () => undefined),
      runText: vi.fn(async () => undefined),
      resetSession: vi.fn(async () => {}),
      abortTurn: vi.fn(async () => false),
      status: vi.fn(() => ({ busy: false })),
      close: vi.fn(async () => {}),
    },
    notify: createNotifyOnce(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

function event(eventType: string, payload: Record<string, unknown>): VerifiedEvent {
  return {
    provider: "inkbox",
    verified: true,
    eventType,
    requestId: "req-1",
    body: { data: payload },
    headers: {},
  };
}

beforeEach(() => {
  vi.mocked(downloadMedia).mockClear();
  vi.mocked(mediaDir).mockClear();
});

describe("dispatchEvent inbound", () => {
  it("routes an email message.received to a session on the email channel", async () => {
    const deps = makeDeps();
    const ok = await dispatchEvent(
      deps,
      event("message.received", {
        message: {
          id: "m-1",
          from_address: "sender@example.com",
          message_id: "<rfc-1@mail>",
          subject: "Status?",
          body: "How is it going",
          thread_id: "t-1",
          has_attachments: false,
        },
        contacts: [],
        agent_identities: [],
      }),
    );

    expect(ok).toBe(true);
    expect(deps.sessions.handleInbound).toHaveBeenCalledTimes(1);
    expect(deps.sessions.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        from: "sender@example.com",
        subject: "Status?",
        text: "How is it going",
        chatKey: "ck",
        contactId: "c1",
        contactName: "Ada",
        rfcMessageId: "<rfc-1@mail>",
      }),
    );
  });

  it("drops a bare SMS carrier control word without waking the agent", async () => {
    const deps = makeDeps();
    const ok = await dispatchEvent(
      deps,
      event("text.received", {
        text_message: {
          id: "tm-1",
          remote_phone_number: "+15551112222",
          text: "STOP",
          conversation_id: "sms-conv-1",
          media: null,
        },
        contacts: [],
        agent_identities: [],
      }),
    );

    expect(ok).toBe(true);
    expect(deps.sessions.handleInbound).not.toHaveBeenCalled();
  });

  it("ignores a message whose sender is one of the agent's own addresses", async () => {
    const deps = makeDeps();
    await dispatchEvent(
      deps,
      event("message.received", {
        message: { id: "m-2", from_address: "me@agents.inkbox.ai", body: "loopback" },
        contacts: [],
        agent_identities: [],
      }),
    );

    expect(deps.sessions.handleInbound).not.toHaveBeenCalled();
  });

  it("ignores a sender who is not on a configured allowlist", async () => {
    const deps = makeDeps({
      config: makeConfig({ allowAllUsers: false, allowedUsers: ["allowed@example.com"] }),
    });
    await dispatchEvent(
      deps,
      event("message.received", {
        message: { id: "m-3", from_address: "blocked@example.com", body: "hi" },
        contacts: [],
        agent_identities: [],
      }),
    );

    expect(deps.sessions.handleInbound).not.toHaveBeenCalled();
  });

  it("downloads inbound media and passes the local paths to the session", async () => {
    const deps = makeDeps();
    await dispatchEvent(
      deps,
      event("text.received", {
        text_message: {
          id: "tm-2",
          remote_phone_number: "+15551112222",
          text: "look at this",
          conversation_id: "sms-conv-2",
          media: [{ content_type: "image/png", size: 1024, url: "https://cdn.example.com/a.png" }],
        },
        contacts: [],
        agent_identities: [],
      }),
    );

    expect(downloadMedia).toHaveBeenCalledTimes(1);
    expect(downloadMedia).toHaveBeenCalledWith(
      ["https://cdn.example.com/a.png"],
      expect.objectContaining({ dir: "/tmp/gw-media" }),
    );
    expect(deps.sessions.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({ mediaPaths: ["/tmp/gw-media/file.png"] }),
    );
  });
});

describe("dispatchEvent reactions", () => {
  it("frames an iMessage reaction as a bracketed reaction turn", async () => {
    const deps = makeDeps();
    await dispatchEvent(
      deps,
      event("imessage.reaction_received", {
        reaction: {
          id: "rx-1",
          conversation_id: "conv-1",
          remote_number: "+15551112222",
          reaction: "loved",
          target_message_id: "im-1",
        },
      }),
    );

    expect(deps.sessions.handleInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "imessage",
        // The reaction line names the target message and leads a short
        // reply-restraint policy blurb ending in the [SILENT] escape.
        text: expect.stringMatching(
          /^\[reaction: loved target_message_id=im-1\]\n.*tapback.*reply with exactly \[SILENT\]\.$/s,
        ),
      }),
    );
  });
});

describe("dispatchEvent delivery failures", () => {
  it("runs a capture on the first failure and dedupes a repeat with the same id", async () => {
    const deps = makeDeps();
    const failure = event("text.delivery_failed", {
      text_message: {
        id: "msg-99",
        remote_phone_number: "+15551112222",
        error_detail: "handset unreachable",
        error_code: "undelivered",
      },
    });

    await dispatchEvent(deps, failure);
    await dispatchEvent(deps, failure);

    expect(deps.sessions.runCapture).toHaveBeenCalledTimes(1);
    expect(deps.sessions.runCapture).toHaveBeenCalledWith(
      "ck",
      expect.stringContaining("+15551112222"),
    );
  });
});

describe("dispatchEvent external providers", () => {
  it("hands a non-inkbox event to onExternal and acks", async () => {
    const onExternal = vi.fn(async () => {});
    const deps = makeDeps({ onExternal });
    const external: VerifiedEvent = {
      provider: "github",
      verified: true,
      eventType: "push",
      body: { ref: "refs/heads/main" },
      headers: {},
    };

    const ok = await dispatchEvent(deps, external);

    expect(ok).toBe(true);
    expect(onExternal).toHaveBeenCalledWith(external);
    expect(deps.sessions.handleInbound).not.toHaveBeenCalled();
  });
});
