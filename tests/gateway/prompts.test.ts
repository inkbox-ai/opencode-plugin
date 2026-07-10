import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildChannelPrompt,
  CHANNEL_PROMPT_BODY,
  frameCapture,
  frameInbound,
  SILENT,
  stripMarkdown,
} from "../../src/gateway/prompts.js";
import type { InboundMessage } from "../../src/gateway/types.js";

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "sms",
    chatKey: "chat-1",
    from: "+15550001111",
    text: "ping",
    mediaPaths: [],
    ...overrides,
  };
}

const GROUP_REMINDER =
  "Group conversation (4 participants): reply only when the latest message clearly " +
  "addresses you or asks you to act; otherwise reply with exactly [SILENT].";

describe("SILENT", () => {
  it("is the exact suppression sentinel", () => {
    expect(SILENT).toBe("[SILENT]");
  });
});

// Unresolved senders carry an explicit unknown marker instead of no card.
const UNKNOWN = "| contact=unknown_in_inkbox";

describe("frameInbound", () => {
  it("frames email with subject and the full contact card", () => {
    const framed = frameInbound(
      makeMsg({
        channel: "email",
        from: "ada@example.com",
        subject: "Build status",
        contactId: "c-1",
        contactName: "Ada Lovelace",
        contactEmails: ["ada@example.com"],
        contactPhones: ["+15550001111"],
        text: "Is the deploy green?",
      }),
    );
    expect(framed).toBe(
      '[inkbox:email from=ada@example.com subject="Build status" | contact_id=c-1 ' +
        'contact_name="Ada Lovelace" contact_emails=ada@example.com ' +
        "contact_phones=+15550001111]\nIs the deploy green?",
    );
  });

  it("marks an unresolved sender as unknown in the tag", () => {
    const framed = frameInbound(
      makeMsg({ channel: "email", from: "ada@example.com", text: "hello" }),
    );
    expect(framed).toBe(`[inkbox:email from=ada@example.com ${UNKNOWN}]\nhello`);
  });

  it("frames sms with its conversation id", () => {
    const framed = frameInbound(makeMsg({ conversationId: "conv-9" }));
    expect(framed).toBe(`[inkbox:sms from=+15550001111 conversation_id=conv-9 ${UNKNOWN}]\nping`);
  });

  it("frames imessage with conversation id and contact id", () => {
    const framed = frameInbound(
      makeMsg({ channel: "imessage", conversationId: "im-3", contactId: "c-7", text: "hey" }),
    );
    expect(framed).toBe(
      "[inkbox:imessage from=+15550001111 conversation_id=im-3 | contact_id=c-7]\nhey",
    );
  });

  it("frames voice with the caller only when no conversation id exists", () => {
    const framed = frameInbound(makeMsg({ channel: "voice", text: "call me back" }));
    expect(framed).toBe(`[inkbox:voice from=+15550001111 ${UNKNOWN}]\ncall me back`);
  });

  it("inserts a one-line group policy reminder for group messages", () => {
    const framed = frameInbound(
      makeMsg({ conversationId: "conv-9", group: { participantCount: 4 }, text: "lunch?" }),
    );
    expect(framed).toBe(
      `[inkbox:sms from=+15550001111 conversation_id=conv-9 ${UNKNOWN}]\n${GROUP_REMINDER}\nlunch?`,
    );
  });

  it("appends attached file paths after the body", () => {
    const framed = frameInbound(makeMsg({ mediaPaths: ["/media/a.png", "/media/b.pdf"] }));
    expect(framed).toBe(
      `[inkbox:sms from=+15550001111 ${UNKNOWN}]\nping\n[attached files: /media/a.png, /media/b.pdf]`,
    );
  });

  it("frames a group message with media as tag, reminder, body, then files", () => {
    const framed = frameInbound(
      makeMsg({
        conversationId: "conv-9",
        group: { participantCount: 4 },
        text: "see photo",
        mediaPaths: ["/media/a.png"],
      }),
    );
    expect(framed).toBe(
      `[inkbox:sms from=+15550001111 conversation_id=conv-9 ${UNKNOWN}]\n${GROUP_REMINDER}\n` +
        "see photo\n[attached files: /media/a.png]",
    );
  });
});

describe("frameCapture", () => {
  it("tags the turn as a system event and warns the reply is not delivered", () => {
    expect(frameCapture("delivery_failure", "SMS to +15550002222 was NOT delivered.")).toBe(
      "[inkbox:system delivery_failure]\nSMS to +15550002222 was NOT delivered.\n\n" +
        "This is a system event, not a message from a person. Your text reply to this turn " +
        "is not delivered anywhere — if action is needed, act through your tools.",
    );
  });

  it("carries any event kind verbatim", () => {
    const framed = frameCapture("external_event", "CI run failed on main.");
    expect(framed.startsWith("[inkbox:system external_event]\nCI run failed on main.\n\n")).toBe(
      true,
    );
  });
});

describe("stripMarkdown", () => {
  it("removes heading markers", () => {
    expect(stripMarkdown("# Title\n## Sub\nBody")).toBe("Title\nSub\nBody");
  });

  it("unwraps bold and italic emphasis", () => {
    expect(stripMarkdown("**done** and *fast*")).toBe("done and fast");
  });

  it("unwraps inline code and code fences but keeps the code", () => {
    expect(stripMarkdown("run `npm test` first")).toBe("run npm test first");
    expect(stripMarkdown("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it('rewrites links as "text (url)"', () => {
    expect(stripMarkdown("see [the docs](https://example.com/x)")).toBe(
      "see the docs (https://example.com/x)",
    );
  });

  it('normalizes list bullets to "- "', () => {
    expect(stripMarkdown("* one\n+ two\n-   three")).toBe("- one\n- two\n- three");
  });

  it("trims surrounding whitespace", () => {
    expect(stripMarkdown("  hi there \n")).toBe("hi there");
  });

  it("leaves snake_case identifiers and the SILENT sentinel untouched", () => {
    expect(stripMarkdown("call inkbox_send_sms")).toBe("call inkbox_send_sms");
    expect(stripMarkdown(SILENT)).toBe(SILENT);
  });
});

describe("buildChannelPrompt", () => {
  const full = buildChannelPrompt({
    handle: "scout",
    emailAddress: "scout@agents.inkbox.ai",
    dedicatedNumber: "+15551230000",
    imessageEnabled: true,
  });

  it("lists every provisioned address on the identity line", () => {
    expect(full).toContain(
      "reachable at: scout / scout@agents.inkbox.ai / +15551230000 / iMessage (shared line).",
    );
  });

  it("falls back to an unprovisioned identity line when nothing is set", () => {
    expect(buildChannelPrompt({})).toContain("reachable at: not yet provisioned.");
    expect(buildChannelPrompt({ emailAddress: null, dedicatedNumber: null })).toContain(
      "reachable at: not yet provisioned.",
    );
  });

  it("states the plain-text rule for phone channels", () => {
    expect(full).toContain("Plain text only.");
    expect(full).toContain("No markdown on phone channels");
  });

  it("explains the SILENT sentinel and group etiquette", () => {
    expect(full).toContain("reply with exactly [SILENT]");
    expect(full).toContain("reply only when the latest message clearly addresses you");
  });

  it("describes the two calling lines and their origination values", () => {
    expect(full).toContain("two lines");
    expect(full).toContain('"dedicated_number"');
    expect(full).toContain('"shared_imessage_number"');
  });

  it("tells the agent to summarize and offer email instead of pasting logs", () => {
    expect(full).toContain("Never paste diffs, stack traces, or logs");
    expect(full).toContain("offer to email the details");
  });
});

describe("agents/inkbox-channel.md", () => {
  const raw = readFileSync(new URL("../../agents/inkbox-channel.md", import.meta.url), "utf-8");
  const parsed = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);

  it("declares minimal frontmatter: a description and primary mode", () => {
    expect(parsed).not.toBeNull();
    const frontmatter = parsed?.[1] ?? "";
    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("mode: primary");
  });

  it("carries the shared channel prompt body verbatim, with no placeholders", () => {
    const body = (parsed?.[2] ?? "").trim();
    expect(body).toBe(CHANNEL_PROMPT_BODY.trim());
    expect(body).not.toContain("{");
  });
});
