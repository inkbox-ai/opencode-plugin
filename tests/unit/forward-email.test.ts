import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { forwardEmailTools } from "../../src/tools/forward-email.js";

function makeDeps(identityStub: Record<string, unknown>, overrides?: Record<string, unknown>) {
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
  return { runtime, config, vault } as any;
}

function makeCtx() {
  return { ask: vi.fn(async () => {}), abort: new AbortController().signal } as any;
}

describe("forwardEmailTools", () => {
  it("registers inkbox_forward_email in the email group, disabled by default", () => {
    const tools = forwardEmailTools(makeDeps({}));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_forward_email");
    expect(tool.group).toBe("email");
    expect(tool.defaultEnabled).toBe(false);
    expect(tool.sensitive).toBeUndefined();
  });

  it("forwards a message and reports the new message id and recipients", async () => {
    const forwardEmail = vi.fn(async () => ({ id: "fwd-77" }));
    const deps = makeDeps({ forwardEmail });
    const [tool] = forwardEmailTools(deps);
    const result = await tool.definition.execute(
      {
        messageId: "msg-1",
        to: ["a@example.com"],
        cc: ["b@example.com"],
        subject: "Fwd: hello",
        bodyText: "see below",
      } as any,
      makeCtx(),
    );
    expect(forwardEmail).toHaveBeenCalledWith("msg-1", {
      to: ["a@example.com"],
      cc: ["b@example.com"],
      bcc: undefined,
      mode: undefined,
      subject: "Fwd: hello",
      bodyText: "see below",
      bodyHtml: undefined,
      includeOriginalAttachments: undefined,
      replyTo: undefined,
    });
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("Forwarded message id=msg-1 as=fwd-77");
    expect(output).toContain("to=a@example.com,b@example.com");
    expect(output).toContain("mode=inline");
  });

  it("passes an explicit wrapped mode through to the SDK and the summary", async () => {
    const forwardEmail = vi.fn(async () => ({ id: "fwd-9" }));
    const deps = makeDeps({ forwardEmail });
    const [tool] = forwardEmailTools(deps);
    const result = await tool.definition.execute(
      { messageId: "msg-2", to: ["a@example.com"], mode: "wrapped" } as any,
      makeCtx(),
    );
    expect(forwardEmail).toHaveBeenCalledWith(
      "msg-2",
      expect.objectContaining({ mode: "wrapped" }),
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("mode=wrapped");
  });

  it("accepts a valid args shape and rejects a missing messageId", () => {
    const [tool] = forwardEmailTools(makeDeps({}));
    const schema = z.object(tool.definition.args);
    expect(
      schema.safeParse({
        messageId: "msg-1",
        to: ["a@example.com"],
        mode: "inline",
        includeOriginalAttachments: true,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ to: ["a@example.com"] }).success).toBe(false);
    expect(schema.safeParse({ messageId: "msg-1", to: "not-an-array" }).success).toBe(false);
  });

  it("rejects recipients missing from the allowlist without calling the SDK", async () => {
    const forwardEmail = vi.fn(async () => ({ id: "fwd-1" }));
    const deps = makeDeps(
      { forwardEmail },
      {
        outbound: { allowedRecipients: ["allowed@x.com"], approval: "allowlist", askTimeoutMs: 0 },
      },
    );
    const [tool] = forwardEmailTools(deps);
    await expect(
      tool.definition.execute({ messageId: "msg-1", to: ["other@x.com"] } as any, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(forwardEmail).not.toHaveBeenCalled();
  });

  it("checks bcc recipients against the allowlist too", async () => {
    const forwardEmail = vi.fn(async () => ({ id: "fwd-1" }));
    const deps = makeDeps(
      { forwardEmail },
      {
        outbound: { allowedRecipients: ["allowed@x.com"], approval: "allowlist", askTimeoutMs: 0 },
      },
    );
    const [tool] = forwardEmailTools(deps);
    await expect(
      tool.definition.execute(
        { messageId: "msg-1", to: ["allowed@x.com"], bcc: ["sneaky@x.com"] } as any,
        makeCtx(),
      ),
    ).rejects.toThrow(/allowlist/);
    expect(forwardEmail).not.toHaveBeenCalled();
  });

  it("asks for approval before forwarding when approval mode is ask", async () => {
    const forwardEmail = vi.fn(async () => ({ id: "fwd-3" }));
    const deps = makeDeps(
      { forwardEmail },
      { outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 } },
    );
    const [tool] = forwardEmailTools(deps);
    const ctx = makeCtx();
    await tool.definition.execute({ messageId: "msg-1", to: ["a@example.com"] } as any, ctx);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const askInput = ctx.ask.mock.calls[0][0];
    expect(askInput.permission).toBe("inkbox_forward_email");
    expect(askInput.patterns).toEqual(["a@example.com"]);
    expect(forwardEmail).toHaveBeenCalledTimes(1);
  });
});
