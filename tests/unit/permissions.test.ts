import { describe, expect, it, vi } from "vitest";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import {
  approveOutbound,
  checkOutboundRecipient,
  checkOutboundRecipients,
} from "../../src/permissions.js";

function makeConfig(outbound?: Partial<ResolvedConfig["outbound"]>): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0, ...outbound },
    gateway: defaultGatewayConfig(),
  };
}

function makeCtx(ask = vi.fn(async () => {})) {
  return { ask, abort: new AbortController().signal } as any;
}

const REQUEST = {
  tool: "inkbox_send_email",
  recipients: ["a@example.com", "b@example.com"],
  summary: 'Send email to a@example.com, b@example.com: "Hi"',
  metadata: { subject: "Hi" },
};

describe("checkOutboundRecipient", () => {
  it("allows everything when the allowlist is empty or unset", () => {
    expect(checkOutboundRecipient("anyone@example.com", undefined)).toBeNull();
    expect(checkOutboundRecipient("anyone@example.com", [])).toBeNull();
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const allowed = [" Friend@Example.COM ", "+15550001111"];
    expect(checkOutboundRecipient("friend@example.com", allowed)).toBeNull();
    expect(checkOutboundRecipient("  FRIEND@EXAMPLE.COM  ", allowed)).toBeNull();
    expect(checkOutboundRecipient("+15550001111", allowed)).toBeNull();
  });

  it("returns a reason naming the blocked recipient", () => {
    const reason = checkOutboundRecipient("stranger@example.com", ["friend@example.com"]);
    expect(reason).toContain("stranger@example.com");
    expect(reason).toContain("not on the outbound allowlist");
  });
});

describe("checkOutboundRecipients", () => {
  it("passes when every recipient is allowed", () => {
    expect(checkOutboundRecipients(["a@x.com", "B@X.COM"], ["a@x.com", "b@x.com"])).toBeNull();
  });

  it("returns the first blocking reason", () => {
    const reason = checkOutboundRecipients(["ok@x.com", "bad1@y.com", "bad2@y.com"], ["ok@x.com"]);
    expect(reason).toContain("bad1@y.com");
    expect(reason).not.toContain("bad2@y.com");
  });
});

describe("approveOutbound", () => {
  it("resolves without asking when no allowlist is configured in auto mode", async () => {
    const ctx = makeCtx();
    await approveOutbound(ctx, makeConfig({ approval: "auto" }), REQUEST);
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  it("throws for a blocked recipient before consulting the permission system", async () => {
    const ctx = makeCtx();
    const config = makeConfig({ approval: "ask", allowedRecipients: ["a@example.com"] });
    await expect(approveOutbound(ctx, config, REQUEST)).rejects.toThrow(/allowlist/);
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  it('never asks in "allowlist" mode when recipients pass the list', async () => {
    const ctx = makeCtx();
    const config = makeConfig({
      approval: "allowlist",
      allowedRecipients: ["a@example.com", "b@example.com"],
    });
    await approveOutbound(ctx, config, REQUEST);
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  it('never asks in "auto" mode even with an allowlist configured', async () => {
    const ctx = makeCtx();
    const config = makeConfig({
      approval: "auto",
      allowedRecipients: ["a@example.com", "b@example.com"],
    });
    await approveOutbound(ctx, config, REQUEST);
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  it('asks in "ask" mode with the tool name as the permission id and recipients as patterns', async () => {
    const ctx = makeCtx();
    await approveOutbound(ctx, makeConfig({ approval: "ask", askTimeoutMs: 0 }), REQUEST);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const input = ctx.ask.mock.calls[0][0];
    expect(input.permission).toBe("inkbox_send_email");
    expect(input.patterns).toEqual(["a@example.com", "b@example.com"]);
    expect(input.always).toEqual(["a@example.com", "b@example.com"]);
    expect(input.metadata.summary).toBe(REQUEST.summary);
    expect(input.metadata.recipients).toEqual(REQUEST.recipients);
    expect(input.metadata.subject).toBe("Hi");
  });

  it("propagates a denial from the permission prompt", async () => {
    const ctx = makeCtx(
      vi.fn(async () => {
        throw new Error("denied by user");
      }),
    );
    const config = makeConfig({ approval: "ask", askTimeoutMs: 0 });
    await expect(approveOutbound(ctx, config, REQUEST)).rejects.toThrow("denied by user");
  });

  it("resolves in ask mode when the prompt is answered before the timeout", async () => {
    const ctx = makeCtx();
    const config = makeConfig({ approval: "ask", askTimeoutMs: 60_000 });
    await expect(approveOutbound(ctx, config, REQUEST)).resolves.toBeUndefined();
    expect(ctx.ask).toHaveBeenCalledTimes(1);
  });

  it("times out with actionable guidance when nobody answers the prompt", async () => {
    vi.useFakeTimers();
    try {
      // A prompt with no client attached to answer it never settles.
      const ctx = makeCtx(vi.fn(() => new Promise<never>(() => {})));
      const config = makeConfig({ approval: "ask", askTimeoutMs: 5_000 });
      const pending = approveOutbound(ctx, config, REQUEST);
      const assertion = expect(pending).rejects.toThrow(/timed out after 5s/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
