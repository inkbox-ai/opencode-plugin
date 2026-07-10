import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { sendSmsTools } from "../../src/tools/send-sms.js";
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

function makeIdentity(sendResult?: Record<string, unknown>) {
  return {
    sendText: vi.fn(async () => ({
      id: "txt-1",
      deliveryStatus: "queued",
      recipients: null,
      ...sendResult,
    })),
  };
}

function outputOf(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("sendSmsTools", () => {
  it("registers inkbox_send_sms in the sms group, enabled by default", () => {
    const tools = sendSmsTools(makeDeps(makeIdentity()));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_send_sms");
    expect(tool.group).toBe("sms");
    expect(tool.defaultEnabled).toBe(true);
    expect(tool.sensitive).toBeFalsy();
  });

  it("sends a single-recipient text and reports id, target, and status", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    const result = await tool.definition.execute({ to: "+14155550123", text: "Hello" }, makeCtx());
    expect(identity.sendText).toHaveBeenCalledWith({ text: "Hello", to: "+14155550123" });
    expect(result).toMatchObject({ title: expect.stringContaining("+14155550123") });
    const output = outputOf(result);
    expect(output).toContain("Sent text id=txt-1");
    expect(output).toContain("to=+14155550123");
    expect(output).toContain("status=queued");
    expect(output).toContain("(5 chars)");
  });

  it("sends a group MMS when `to` has multiple recipients", async () => {
    const identity = makeIdentity({
      recipients: [
        { recipientPhoneNumber: "+14155550123" },
        { recipientPhoneNumber: "+14155550124" },
      ],
    });
    const [tool] = sendSmsTools(makeDeps(identity));
    const result = await tool.definition.execute(
      { to: ["+14155550123", "+14155550124"], text: "Hi" },
      makeCtx(),
    );
    expect(identity.sendText).toHaveBeenCalledWith({
      text: "Hi",
      to: ["+14155550123", "+14155550124"],
    });
    expect(outputOf(result)).toContain("to=+14155550123,+14155550124");
  });

  it("replies into an existing conversation by UUID", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    const result = await tool.definition.execute(
      { conversationId: "3f1c9a2e-1111-2222-3333-444455556666", text: "Hi" },
      makeCtx(),
    );
    expect(identity.sendText).toHaveBeenCalledWith({
      text: "Hi",
      conversationId: "3f1c9a2e-1111-2222-3333-444455556666",
    });
    expect(outputOf(result)).toContain("conversation=3f1c9a2e-1111-2222-3333-444455556666");
  });

  it("passes MMS media urls through to the send call", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    await tool.definition.execute(
      { to: "+14155550123", text: "pic", mediaUrls: ["https://example.com/a.jpg"] },
      makeCtx(),
    );
    expect(identity.sendText).toHaveBeenCalledWith({
      text: "pic",
      to: "+14155550123",
      mediaUrls: ["https://example.com/a.jpg"],
    });
  });

  it("trims recipient whitespace before sending", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    await tool.definition.execute({ to: "  +14155550123  ", text: "Hi" }, makeCtx());
    expect(identity.sendText).toHaveBeenCalledWith({ text: "Hi", to: "+14155550123" });
  });

  it("rejects when both `to` and `conversationId` are provided", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    await expect(
      tool.definition.execute(
        { to: "+14155550123", conversationId: "conv-1", text: "Hi" },
        makeCtx(),
      ),
    ).rejects.toThrow(/exactly one/);
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("rejects when neither `to` nor `conversationId` is provided", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    await expect(tool.definition.execute({ text: "Hi" }, makeCtx())).rejects.toThrow(/exactly one/);
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("rejects group sends with more than 8 recipients", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    const nine = Array.from({ length: 9 }, (_, i) => `+1415555010${i}`);
    await expect(tool.definition.execute({ to: nine, text: "Hi" }, makeCtx())).rejects.toThrow(
      /at most 8/,
    );
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("rejects text longer than the SMS limit", async () => {
    const identity = makeIdentity();
    const [tool] = sendSmsTools(makeDeps(identity));
    await expect(
      tool.definition.execute({ to: "+14155550123", text: "x".repeat(1601) }, makeCtx()),
    ).rejects.toThrow(/maximum is 1600/);
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("declares an args schema that accepts valid input and rejects bad input", () => {
    const [tool] = sendSmsTools(makeDeps(makeIdentity()));
    const schema = z.object(tool.definition.args);
    expect(schema.safeParse({ to: "+14155550123", text: "Hi" }).success).toBe(true);
    expect(
      schema.safeParse({
        to: ["+14155550123", "+14155550124"],
        text: "Hi",
        mediaUrls: ["https://example.com/a.jpg"],
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ conversationId: "conv-1", text: "Hi" }).success).toBe(true);
    // text is required and must be non-empty
    expect(schema.safeParse({ to: "+14155550123" }).success).toBe(false);
    expect(schema.safeParse({ to: "+14155550123", text: "" }).success).toBe(false);
    // to must be a string or an array of at most 8 strings
    expect(schema.safeParse({ to: 5, text: "Hi" }).success).toBe(false);
    expect(
      schema.safeParse({
        to: Array.from({ length: 9 }, (_, i) => `+1415555010${i}`),
        text: "Hi",
      }).success,
    ).toBe(false);
  });

  it("rejects recipients missing from the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendSmsTools(deps);
    await expect(
      tool.definition.execute({ to: "+15555550100", text: "Hi" }, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("allows recipients present on the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendSmsTools(deps);
    await tool.definition.execute({ to: "+14155550123", text: "Hi" }, makeCtx());
    expect(identity.sendText).toHaveBeenCalledTimes(1);
  });

  it("rejects conversation sends when a recipient allowlist is configured", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendSmsTools(deps);
    await expect(
      tool.definition.execute({ conversationId: "conv-1", text: "Hi" }, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("requests approval through the permission system in ask mode", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
    });
    const [tool] = sendSmsTools(deps);
    const ctx = makeCtx();
    await tool.definition.execute({ to: ["+14155550123", "+14155550124"], text: "Hi" }, ctx);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const askInput = ctx.ask.mock.calls[0][0];
    expect(askInput.permission).toBe("inkbox_send_sms");
    expect(askInput.patterns).toEqual(["+14155550123", "+14155550124"]);
    expect(askInput.metadata.summary).toContain("+14155550123");
    expect(identity.sendText).toHaveBeenCalledTimes(1);
  });
});
