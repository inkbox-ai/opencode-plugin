import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { sendIMessageTools } from "../../src/tools/send-imessage.js";
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
    sendIMessage: vi.fn(async () => ({
      id: "im-1",
      conversationId: "conv-9",
      status: "sent",
      ...sendResult,
    })),
  };
}

function outputOf(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("sendIMessageTools", () => {
  it("registers inkbox_send_imessage in the imessage group, enabled by default", () => {
    const tools = sendIMessageTools(makeDeps(makeIdentity()));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_send_imessage");
    expect(tool.group).toBe("imessage");
    expect(tool.defaultEnabled).toBe(true);
    expect(tool.sensitive).toBeFalsy();
  });

  it("sends to an E.164 recipient and reports id, target, and status", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    const result = await tool.definition.execute({ to: "+14155550123", text: "Hello" }, makeCtx());
    expect(identity.sendIMessage).toHaveBeenCalledWith({ to: "+14155550123", text: "Hello" });
    expect(result).toMatchObject({ title: expect.stringContaining("+14155550123") });
    const output = outputOf(result);
    expect(output).toContain("Sent iMessage id=im-1");
    expect(output).toContain("to=+14155550123");
    expect(output).toContain("conversation_id=conv-9");
    expect(output).toContain("status=sent");
  });

  it("replies into an existing conversation by UUID", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    const result = await tool.definition.execute(
      { conversationId: "3f1c9a2e-1111-2222-3333-444455556666", text: "Hi" },
      makeCtx(),
    );
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      conversationId: "3f1c9a2e-1111-2222-3333-444455556666",
      text: "Hi",
    });
    expect(outputOf(result)).toContain("conversation=3f1c9a2e-1111-2222-3333-444455556666");
  });

  it("reports status=unknown when the API omits a delivery status", async () => {
    const identity = makeIdentity({ status: null });
    const [tool] = sendIMessageTools(makeDeps(identity));
    const result = await tool.definition.execute({ to: "+14155550123", text: "Hi" }, makeCtx());
    expect(outputOf(result)).toContain("status=unknown");
  });

  it("passes media urls and send style through to the send call", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await tool.definition.execute(
      {
        to: "+14155550123",
        text: "pic",
        mediaUrls: ["https://example.com/a.jpg"],
        sendStyle: "confetti",
      },
      makeCtx(),
    );
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      to: "+14155550123",
      text: "pic",
      mediaUrls: ["https://example.com/a.jpg"],
      sendStyle: "confetti",
    });
  });

  it("sends a media-only message without a text field", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await tool.definition.execute(
      { to: "+14155550123", mediaUrls: ["https://example.com/a.jpg"] },
      makeCtx(),
    );
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      to: "+14155550123",
      mediaUrls: ["https://example.com/a.jpg"],
    });
  });

  it("trims recipient whitespace before sending", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await tool.definition.execute({ to: "  +14155550123  ", text: "Hi" }, makeCtx());
    expect(identity.sendIMessage).toHaveBeenCalledWith({ to: "+14155550123", text: "Hi" });
  });

  it("rejects when neither `text` nor `mediaUrls` is provided", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await expect(tool.definition.execute({ to: "+14155550123" }, makeCtx())).rejects.toThrow(
      /Provide `text`, `mediaUrls`, or both/,
    );
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("rejects when both `to` and `conversationId` are provided", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await expect(
      tool.definition.execute(
        { to: "+14155550123", conversationId: "conv-1", text: "Hi" },
        makeCtx(),
      ),
    ).rejects.toThrow(/exactly one/);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("rejects when neither `to` nor `conversationId` is provided", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await expect(tool.definition.execute({ text: "Hi" }, makeCtx())).rejects.toThrow(/exactly one/);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("rejects text longer than the iMessage limit", async () => {
    const identity = makeIdentity();
    const [tool] = sendIMessageTools(makeDeps(identity));
    await expect(
      tool.definition.execute({ to: "+14155550123", text: "x".repeat(18996) }, makeCtx()),
    ).rejects.toThrow(/maximum is 18995/);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("declares an args schema that accepts valid input and rejects bad input", () => {
    const [tool] = sendIMessageTools(makeDeps(makeIdentity()));
    const schema = z.object(tool.definition.args);
    expect(schema.safeParse({ to: "+14155550123", text: "Hi" }).success).toBe(true);
    expect(schema.safeParse({ conversationId: "conv-1", text: "Hi" }).success).toBe(true);
    expect(
      schema.safeParse({
        to: "+14155550123",
        text: "Hi",
        mediaUrls: ["https://example.com/a.jpg"],
        sendStyle: "lasers",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ to: "+14155550123", mediaUrls: ["https://x.com/a.png"] }).success,
    ).toBe(true);
    // to must be a string, not a number or an array
    expect(schema.safeParse({ to: 5, text: "Hi" }).success).toBe(false);
    // at most one media attachment per message
    expect(
      schema.safeParse({
        to: "+14155550123",
        mediaUrls: ["https://x.com/a.png", "https://x.com/b.png"],
      }).success,
    ).toBe(false);
    // sendStyle must be one of the known styles
    expect(
      schema.safeParse({ to: "+14155550123", text: "Hi", sendStyle: "sparkles" }).success,
    ).toBe(false);
    // text must fit within the iMessage character limit
    expect(schema.safeParse({ to: "+14155550123", text: "x".repeat(18996) }).success).toBe(false);
  });

  it("rejects recipients missing from the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendIMessageTools(deps);
    await expect(
      tool.definition.execute({ to: "+15555550100", text: "Hi" }, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("allows recipients present on the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendIMessageTools(deps);
    await tool.definition.execute({ to: "+14155550123", text: "Hi" }, makeCtx());
    expect(identity.sendIMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects conversation sends when a recipient allowlist is configured", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["+14155550123"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendIMessageTools(deps);
    await expect(
      tool.definition.execute({ conversationId: "conv-1", text: "Hi" }, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });

  it("requests approval through the permission system in ask mode", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
    });
    const [tool] = sendIMessageTools(deps);
    const ctx = makeCtx();
    await tool.definition.execute({ to: "+14155550123", text: "Hi" }, ctx);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const askInput = ctx.ask.mock.calls[0][0];
    expect(askInput.permission).toBe("inkbox_send_imessage");
    expect(askInput.patterns).toEqual(["+14155550123"]);
    expect(askInput.metadata.summary).toContain("+14155550123");
    expect(identity.sendIMessage).toHaveBeenCalledTimes(1);
  });
});
