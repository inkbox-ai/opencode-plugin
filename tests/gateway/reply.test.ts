// Reply delivery: silent/empty suppression, per-channel send routing,
// email subject threading, markdown stripping, and length caps.
import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { deliverReply } from "../../src/gateway/reply.js";
import type { GatewayLogger, ReplyTarget } from "../../src/gateway/types.js";
import { IMESSAGE_MAX_TEXT_CHARS, SMS_MAX_TEXT_CHARS } from "../../src/limits.js";

function makeIdentity() {
  return {
    sendEmail: vi.fn(async (_opts: Record<string, unknown>) => ({ id: "email-1" })),
    sendText: vi.fn(async (_opts: Record<string, unknown>) => ({ id: "sms-1" })),
    sendIMessage: vi.fn(async (_opts: Record<string, unknown>) => ({ id: "im-1" })),
  };
}

function makeRuntime(identity: ReturnType<typeof makeIdentity>): InkboxRuntime {
  return {
    getIdentity: vi.fn(async () => identity),
    getClient: vi.fn(),
  } as unknown as InkboxRuntime;
}

function makeLogger(): GatewayLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function deliver(target: ReplyTarget, raw: string) {
  const identity = makeIdentity();
  const runtime = makeRuntime(identity);
  return { identity, result: deliverReply(runtime, target, raw, makeLogger()) };
}

describe("deliverReply suppression", () => {
  it("suppresses an exact [SILENT] reply without touching the SDK", async () => {
    const { identity, result } = deliver({ channel: "sms", to: "+15551112222" }, "[SILENT]");
    await expect(result).resolves.toEqual({ delivered: false, reason: "silent" });
    expect(identity.sendText).not.toHaveBeenCalled();
  });

  it("treats [SILENT] with surrounding whitespace as silent", async () => {
    const { result } = deliver({ channel: "sms", to: "+15551112222" }, "  \n[SILENT]\n ");
    await expect(result).resolves.toEqual({ delivered: false, reason: "silent" });
  });

  it("suppresses an empty reply and a whitespace-only reply", async () => {
    const { identity, result } = deliver({ channel: "email", to: "a@b.com" }, "");
    await expect(result).resolves.toEqual({ delivered: false, reason: "empty" });
    const blank = deliver({ channel: "email", to: "a@b.com" }, "   \t\n  ");
    await expect(blank.result).resolves.toEqual({ delivered: false, reason: "empty" });
    expect(identity.sendEmail).not.toHaveBeenCalled();
  });
});

describe("deliverReply email", () => {
  it("sends to the target with a single Re: prefix and threads by message id", async () => {
    const target: ReplyTarget = {
      channel: "email",
      to: "user@example.com",
      subject: "Weekly report",
      rfcMessageId: "<abc@mail>",
    };
    const { identity, result } = deliver(target, "All done.");
    await expect(result).resolves.toEqual({
      delivered: true,
      reason: "sent",
      messageId: "email-1",
    });
    expect(identity.sendEmail).toHaveBeenCalledWith({
      to: ["user@example.com"],
      subject: "Re: Weekly report",
      bodyText: "All done.",
      inReplyToMessageId: "<abc@mail>",
    });
  });

  it("does not double an existing Re: prefix (any case)", async () => {
    const upper = deliver({ channel: "email", to: "x@y.com", subject: "Re: Weekly report" }, "ok");
    await upper.result;
    expect(upper.identity.sendEmail.mock.calls[0][0].subject).toBe("Re: Weekly report");

    const lower = deliver({ channel: "email", to: "x@y.com", subject: "re: hi" }, "ok");
    await lower.result;
    expect(lower.identity.sendEmail.mock.calls[0][0].subject).toBe("re: hi");
  });

  it("falls back to a bare Re: when there is no subject", async () => {
    const { identity, result } = deliver({ channel: "email", to: "x@y.com" }, "ok");
    await result;
    expect(identity.sendEmail.mock.calls[0][0].subject).toBe("Re:");
  });

  it("omits inReplyToMessageId when the original message id was not captured", async () => {
    const { identity, result } = deliver({ channel: "email", to: "x@y.com", subject: "Hi" }, "ok");
    await result;
    expect("inReplyToMessageId" in identity.sendEmail.mock.calls[0][0]).toBe(false);
  });
});

describe("deliverReply sms", () => {
  it("routes to the conversation id when present and strips markdown", async () => {
    const target: ReplyTarget = { channel: "sms", to: "+15551112222", conversationId: "conv-9" };
    const { identity, result } = deliver(target, "Hello **world**");
    await expect(result).resolves.toEqual({ delivered: true, reason: "sent", messageId: "sms-1" });
    expect(identity.sendText).toHaveBeenCalledWith({
      text: "Hello world",
      conversationId: "conv-9",
    });
  });

  it("falls back to the sender address when there is no conversation id", async () => {
    const { identity, result } = deliver({ channel: "sms", to: "+15551112222" }, "hi there");
    await result;
    expect(identity.sendText).toHaveBeenCalledWith({ text: "hi there", to: "+15551112222" });
  });

  it("throws when the stripped body exceeds the SMS length cap", async () => {
    const target: ReplyTarget = { channel: "sms", to: "+15551112222" };
    const long = "a".repeat(SMS_MAX_TEXT_CHARS + 1);
    await expect(deliver(target, long).result).rejects.toThrow(String(SMS_MAX_TEXT_CHARS));
  });
});

describe("deliverReply imessage", () => {
  it("routes to the conversation id when present and strips markdown", async () => {
    const target: ReplyTarget = { channel: "imessage", to: "+15551112222", conversationId: "im-7" };
    const { identity, result } = deliver(target, "See `code` here");
    await expect(result).resolves.toEqual({ delivered: true, reason: "sent", messageId: "im-1" });
    expect(identity.sendIMessage).toHaveBeenCalledWith({
      text: "See code here",
      conversationId: "im-7",
    });
  });

  it("falls back to the sender address when there is no conversation id", async () => {
    const { identity, result } = deliver({ channel: "imessage", to: "+15551112222" }, "yo");
    await result;
    expect(identity.sendIMessage).toHaveBeenCalledWith({ text: "yo", to: "+15551112222" });
  });

  it("throws when the stripped body exceeds the iMessage length cap", async () => {
    const target: ReplyTarget = { channel: "imessage", to: "+15551112222" };
    const long = "a".repeat(IMESSAGE_MAX_TEXT_CHARS + 1);
    await expect(deliver(target, long).result).rejects.toThrow(String(IMESSAGE_MAX_TEXT_CHARS));
  });
});
