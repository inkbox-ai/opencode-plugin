// Cross-cutting outbound-gating behaviors: misconfiguration guards, the
// empty-patterns rule, conversation patterns, and abort handling.
import { describe, expect, it, vi } from "vitest";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import { approveOutbound } from "../../src/permissions.js";
import { forwardEmailTools } from "../../src/tools/forward-email.js";
import { placeCallTools } from "../../src/tools/place-call.js";
import { sendSmsTools } from "../../src/tools/send-sms.js";

function makeConfig(overrides: Partial<ResolvedConfig["outbound"]> = {}): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0, ...overrides },
    gateway: defaultGatewayConfig(),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ask: vi.fn(async () => {}),
    abort: new AbortController().signal,
    ...overrides,
  } as any;
}

function makeDeps(
  identityStub: Record<string, unknown>,
  outbound: Partial<ResolvedConfig["outbound"]> = {},
) {
  return {
    runtime: {
      getIdentity: vi.fn(async () => identityStub),
      getClient: vi.fn(async () => ({})),
    },
    config: makeConfig(outbound),
    vault: { keyEnvVar: "INKBOX_VAULT_KEY", getCredentials: vi.fn() },
  } as any;
}

describe("approveOutbound misconfiguration and patterns", () => {
  it('rejects approval mode "allowlist" with an empty allowlist', async () => {
    await expect(
      approveOutbound(makeCtx(), makeConfig({ approval: "allowlist" }), {
        tool: "inkbox_send_email",
        recipients: ["a@b.com"],
        summary: "s",
      }),
    ).rejects.toThrow(/allowedRecipients is empty/);
  });

  it("never calls ask with an empty patterns array", async () => {
    const ctx = makeCtx();
    await expect(
      approveOutbound(ctx, makeConfig(), {
        tool: "inkbox_send_sms",
        recipients: [],
        summary: "s",
      }),
    ).rejects.toThrow(/at least one recipient or conversation pattern/);
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  it("uses explicit patterns for conversation-addressed sends", async () => {
    const ctx = makeCtx();
    await approveOutbound(ctx, makeConfig(), {
      tool: "inkbox_send_sms",
      recipients: [],
      patterns: ["conversation:abc-123"],
      summary: "s",
    });
    expect(ctx.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        patterns: ["conversation:abc-123"],
        always: ["conversation:abc-123"],
      }),
    );
  });

  it("rejects when the tool call is aborted while waiting for approval", async () => {
    const controller = new AbortController();
    const ctx = makeCtx({
      abort: controller.signal,
      ask: vi.fn(() => new Promise<void>(() => {})),
    });
    const pending = approveOutbound(ctx, makeConfig(), {
      tool: "inkbox_send_email",
      recipients: ["a@b.com"],
      summary: "s",
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe("conversation sends pass synthetic patterns", () => {
  it("inkbox_send_sms conversation sends ask with a conversation pattern", async () => {
    const identity = { sendText: vi.fn(async () => ({ id: "t1", deliveryStatus: "queued" })) };
    const deps = makeDeps(identity);
    const tool = sendSmsTools(deps).find((t) => t.name === "inkbox_send_sms");
    const ctx = makeCtx();
    await tool?.definition.execute({ conversationId: "conv-9", text: "hi" } as any, ctx);
    expect(ctx.ask).toHaveBeenCalledWith(
      expect.objectContaining({ patterns: ["conversation:conv-9"] }),
    );
  });
});

describe("forward-email recipient floor", () => {
  it("rejects a forward with no recipients before asking", async () => {
    const deps = makeDeps({ forwardEmail: vi.fn() });
    const tool = forwardEmailTools(deps).find((t) => t.name === "inkbox_forward_email");
    const ctx = makeCtx();
    await expect(tool?.definition.execute({ messageId: "m1" } as any, ctx)).rejects.toThrow(
      /at least one recipient/,
    );
    expect(ctx.ask).not.toHaveBeenCalled();
  });
});

describe("place-call audio bridge in approval", () => {
  it("shows the resolved bridge URL to the approver", async () => {
    const identity = {
      phoneNumber: { number: "+15550001111" },
      imessageEnabled: false,
      placeCall: vi.fn(async () => ({ id: "c1", status: "queued" })),
    };
    const deps = makeDeps(identity);
    const tool = placeCallTools(deps).find((t) => t.name === "inkbox_place_call");
    const ctx = makeCtx();
    await tool?.definition.execute(
      { toNumber: "+15552223333", clientWebsocketUrl: "wss://bridge.example/ws" } as any,
      ctx,
    );
    expect(ctx.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ clientWebsocketUrl: "wss://bridge.example/ws" }),
      }),
    );
    const summary = (ctx.ask.mock.calls[0][0] as any).metadata.summary as string;
    expect(summary).toContain("wss://bridge.example/ws");
  });

  it("rejects a non-websocket bridge URL before asking", async () => {
    const deps = makeDeps({ phoneNumber: { number: "+15550001111" }, imessageEnabled: false });
    const tool = placeCallTools(deps).find((t) => t.name === "inkbox_place_call");
    const ctx = makeCtx();
    await expect(
      tool?.definition.execute(
        { toNumber: "+15552223333", clientWebsocketUrl: "https://bridge.example/ws" } as any,
        ctx,
      ),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    expect(ctx.ask).not.toHaveBeenCalled();
  });
});
