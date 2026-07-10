import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { placeCallTools } from "../../src/tools/place-call.js";
import type { ToolDeps } from "../../src/tools/types.js";

function makeDeps(
  identityStub: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => ({})),
  };
  const config = {
    apiKey: "k",
    identity: "agent",
    callWebsocketUrl: "wss://bridge.example.com/audio",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    ...overrides,
  };
  const vault = { keyEnvVar: "INKBOX_VAULT_KEY", getCredentials: vi.fn() };
  return { runtime, config, vault } as unknown as ToolDeps;
}

function makeCtx() {
  return { ask: vi.fn(async () => {}), abort: new AbortController().signal } as any;
}

function makeIdentity(overrides?: Record<string, unknown>) {
  return {
    phoneNumber: { number: "+14155559999" },
    imessageEnabled: false,
    placeCall: vi.fn(async () => ({
      id: "call-1",
      status: "queued",
      rateLimit: { callsRemaining: 4 },
    })),
    ...overrides,
  };
}

function outputOf(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("placeCallTools", () => {
  it("registers inkbox_place_call in the calls group, disabled by default", () => {
    const tools = placeCallTools(makeDeps(makeIdentity()));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_place_call");
    expect(tool.group).toBe("calls");
    expect(tool.defaultEnabled).toBe(false);
    expect(tool.sensitive).toBeFalsy();
  });

  it("places a call from the dedicated number and reports id, status, and rate limit", async () => {
    const identity = makeIdentity();
    const [tool] = placeCallTools(makeDeps(identity));
    const result = await tool.definition.execute({ toNumber: "+14155550123" }, makeCtx());
    expect(identity.placeCall).toHaveBeenCalledWith({
      toNumber: "+14155550123",
      origination: "dedicated_number",
      clientWebsocketUrl: "wss://bridge.example.com/audio",
    });
    expect(result).toMatchObject({ title: expect.stringContaining("+14155550123") });
    const output = outputOf(result);
    expect(output).toContain("Placed call id=call-1");
    expect(output).toContain("to=+14155550123");
    expect(output).toContain("status=queued");
    expect(output).toContain("origination=dedicated_number");
    expect(output).toContain("callsRemaining=4");
  });

  it("omits rate-limit info when the response has none", async () => {
    const identity = makeIdentity({
      placeCall: vi.fn(async () => ({ id: "call-2", status: "queued" })),
    });
    const [tool] = placeCallTools(makeDeps(identity));
    const result = await tool.definition.execute({ toNumber: "+14155550123" }, makeCtx());
    expect(outputOf(result)).not.toContain("callsRemaining");
  });

  it("honors an explicit shared_imessage_number origination", async () => {
    const identity = makeIdentity({ imessageEnabled: true });
    const [tool] = placeCallTools(makeDeps(identity));
    const result = await tool.definition.execute(
      { toNumber: "+14155550123", origination: "shared_imessage_number" },
      makeCtx(),
    );
    expect(identity.placeCall).toHaveBeenCalledWith(
      expect.objectContaining({ origination: "shared_imessage_number" }),
    );
    expect(outputOf(result)).toContain("origination=shared_imessage_number");
  });

  it("falls back to the shared iMessage line when no dedicated number exists", async () => {
    const identity = makeIdentity({ phoneNumber: null, imessageEnabled: true });
    const [tool] = placeCallTools(makeDeps(identity));
    await tool.definition.execute({ toNumber: "+14155550123" }, makeCtx());
    expect(identity.placeCall).toHaveBeenCalledWith(
      expect.objectContaining({ origination: "shared_imessage_number" }),
    );
  });

  it("defaults to the dedicated number when both lines are available", async () => {
    const identity = makeIdentity({ imessageEnabled: true });
    const [tool] = placeCallTools(makeDeps(identity));
    await tool.definition.execute({ toNumber: "+14155550123" }, makeCtx());
    expect(identity.placeCall).toHaveBeenCalledWith(
      expect.objectContaining({ origination: "dedicated_number" }),
    );
  });

  it("rejects when the identity has neither a phone number nor iMessage", async () => {
    const identity = makeIdentity({ phoneNumber: null, imessageEnabled: false });
    const [tool] = placeCallTools(makeDeps(identity));
    await expect(tool.definition.execute({ toNumber: "+14155550123" }, makeCtx())).rejects.toThrow(
      /can't place calls/,
    );
    expect(identity.placeCall).not.toHaveBeenCalled();
  });

  it("prefers a per-call clientWebsocketUrl over the configured one", async () => {
    const identity = makeIdentity();
    const [tool] = placeCallTools(makeDeps(identity));
    await tool.definition.execute(
      { toNumber: "+14155550123", clientWebsocketUrl: "wss://override.example.com/ws" },
      makeCtx(),
    );
    expect(identity.placeCall).toHaveBeenCalledWith(
      expect.objectContaining({ clientWebsocketUrl: "wss://override.example.com/ws" }),
    );
  });

  it("rejects with setup guidance when no call WebSocket is configured", async () => {
    const identity = makeIdentity();
    const [tool] = placeCallTools(makeDeps(identity, { callWebsocketUrl: undefined }));
    await expect(tool.definition.execute({ toNumber: "+14155550123" }, makeCtx())).rejects.toThrow(
      /No call WebSocket configured/,
    );
    expect(identity.placeCall).not.toHaveBeenCalled();
  });

  it("translates a no_shared_connection rejection into actionable guidance", async () => {
    const identity = makeIdentity({
      imessageEnabled: true,
      placeCall: vi.fn(async () => {
        throw new Error("403: no_shared_connection");
      }),
    });
    const [tool] = placeCallTools(makeDeps(identity));
    await expect(
      tool.definition.execute(
        { toNumber: "+14155550123", origination: "shared_imessage_number" },
        makeCtx(),
      ),
    ).rejects.toThrow(/isn't connected to you over iMessage/);
  });

  it("rethrows other placeCall failures unchanged", async () => {
    const identity = makeIdentity({
      placeCall: vi.fn(async () => {
        throw new Error("rate_limited");
      }),
    });
    const [tool] = placeCallTools(makeDeps(identity));
    await expect(tool.definition.execute({ toNumber: "+14155550123" }, makeCtx())).rejects.toThrow(
      /rate_limited/,
    );
  });

  it("declares an args schema that accepts valid input and rejects bad input", () => {
    const [tool] = placeCallTools(makeDeps(makeIdentity()));
    const schema = z.object(tool.definition.args);
    expect(schema.safeParse({ toNumber: "+14155550123" }).success).toBe(true);
    expect(
      schema.safeParse({
        toNumber: "+14155550123",
        origination: "shared_imessage_number",
        clientWebsocketUrl: "wss://bridge.example.com/audio",
      }).success,
    ).toBe(true);
    // toNumber is required
    expect(schema.safeParse({}).success).toBe(false);
    // origination must be one of the two known lines
    expect(schema.safeParse({ toNumber: "+14155550123", origination: "landline" }).success).toBe(
      false,
    );
  });

  it("rejects recipients missing from the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = placeCallTools(deps);
    await expect(tool.definition.execute({ toNumber: "+15555550100" }, makeCtx())).rejects.toThrow(
      /allowlist/,
    );
    expect(identity.placeCall).not.toHaveBeenCalled();
  });

  it("allows recipients present on the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = placeCallTools(deps);
    await tool.definition.execute({ toNumber: "+14155550123" }, makeCtx());
    expect(identity.placeCall).toHaveBeenCalledTimes(1);
  });

  it("requests approval through the permission system in ask mode", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
    });
    const [tool] = placeCallTools(deps);
    const ctx = makeCtx();
    await tool.definition.execute({ toNumber: "+14155550123" }, ctx);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const askInput = ctx.ask.mock.calls[0][0];
    expect(askInput.permission).toBe("inkbox_place_call");
    expect(askInput.patterns).toEqual(["+14155550123"]);
    expect(askInput.metadata.summary).toContain("+14155550123");
    expect(identity.placeCall).toHaveBeenCalledTimes(1);
  });
});
