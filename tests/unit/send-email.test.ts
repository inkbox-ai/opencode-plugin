import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import { sendEmailTools } from "../../src/tools/send-email.js";
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

function makeIdentity() {
  return {
    sendEmail: vi.fn(async () => ({ id: "msg-123" })),
  };
}

describe("sendEmailTools", () => {
  it("registers inkbox_send_email in the email group, enabled by default", () => {
    const tools = sendEmailTools(makeDeps(makeIdentity()));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_send_email");
    expect(tool.group).toBe("email");
    expect(tool.defaultEnabled).toBe(true);
    expect(tool.sensitive).toBeFalsy();
  });

  it("sends an email with all fields and reports the message id", async () => {
    const identity = makeIdentity();
    const [tool] = sendEmailTools(makeDeps(identity));
    const result = await tool.definition.execute(
      {
        to: ["a@example.com", "b@example.com"],
        subject: "Hello",
        bodyText: "Hi there",
        bodyHtml: "<p>Hi there</p>",
        cc: ["c@example.com"],
        bcc: ["d@example.com"],
        inReplyToMessageId: "<orig@example.com>",
      },
      makeCtx(),
    );
    expect(identity.sendEmail).toHaveBeenCalledWith({
      to: ["a@example.com", "b@example.com"],
      subject: "Hello",
      bodyText: "Hi there",
      bodyHtml: "<p>Hi there</p>",
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      inReplyToMessageId: "<orig@example.com>",
    });
    expect(result).toMatchObject({ title: expect.stringContaining("a@example.com") });
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("Sent email id=msg-123");
    expect(output).toContain('subject="Hello"');
  });

  it("packages local attachment paths and passes them to sendEmail", async () => {
    const identity = makeIdentity();
    const [tool] = sendEmailTools(makeDeps(identity));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-email-"));
    const file = path.join(dir, "note.txt");
    fs.writeFileSync(file, "hello");
    try {
      await tool.definition.execute(
        { to: ["a@example.com"], subject: "Hi", attachmentPaths: [file] },
        makeCtx(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(identity.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: "note.txt",
            contentType: "text/plain",
            contentBase64: Buffer.from("hello").toString("base64"),
          },
        ],
      }),
    );
  });

  it("accepts a minimal payload and passes optional fields as undefined", async () => {
    const identity = makeIdentity();
    const [tool] = sendEmailTools(makeDeps(identity));
    await tool.definition.execute({ to: ["a@example.com"], subject: "Ping" }, makeCtx());
    expect(identity.sendEmail).toHaveBeenCalledWith({
      to: ["a@example.com"],
      subject: "Ping",
      bodyText: undefined,
      bodyHtml: undefined,
      cc: undefined,
      bcc: undefined,
      inReplyToMessageId: undefined,
    });
  });

  it("declares an args schema that accepts valid input and rejects bad input", () => {
    const [tool] = sendEmailTools(makeDeps(makeIdentity()));
    const schema = z.object(tool.definition.args);
    expect(schema.safeParse({ to: ["a@example.com"], subject: "Hi", bodyText: "x" }).success).toBe(
      true,
    );
    // subject is required
    expect(schema.safeParse({ to: ["a@example.com"] }).success).toBe(false);
    // to must contain at least one recipient
    expect(schema.safeParse({ to: [], subject: "Hi" }).success).toBe(false);
    // to must be an array of strings
    expect(schema.safeParse({ to: "a@example.com", subject: "Hi" }).success).toBe(false);
  });

  it("rejects recipients missing from the allowlist", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["allowed@x.com"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendEmailTools(deps);
    await expect(
      tool.definition.execute({ to: ["stranger@y.com"], subject: "Hi" }, makeCtx()),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendEmail).not.toHaveBeenCalled();
  });

  it("checks cc and bcc recipients against the allowlist too", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: ["allowed@x.com"], approval: "auto", askTimeoutMs: 0 },
    });
    const [tool] = sendEmailTools(deps);
    await expect(
      tool.definition.execute(
        { to: ["allowed@x.com"], subject: "Hi", bcc: ["hidden@y.com"] },
        makeCtx(),
      ),
    ).rejects.toThrow(/allowlist/);
    expect(identity.sendEmail).not.toHaveBeenCalled();
  });

  it("requests approval through the permission system in ask mode", async () => {
    const identity = makeIdentity();
    const deps = makeDeps(identity, {
      outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
    });
    const [tool] = sendEmailTools(deps);
    const ctx = makeCtx();
    await tool.definition.execute(
      { to: ["a@example.com"], subject: "Hi", cc: ["c@example.com"] },
      ctx,
    );
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    const askInput = ctx.ask.mock.calls[0][0];
    expect(askInput.permission).toBe("inkbox_send_email");
    expect(askInput.patterns).toEqual(["a@example.com", "c@example.com"]);
    expect(askInput.metadata.subject).toBe("Hi");
    expect(identity.sendEmail).toHaveBeenCalledTimes(1);
  });
});
