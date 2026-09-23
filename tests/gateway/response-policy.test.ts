import { describe, expect, it } from "vitest";
import { defaultGatewayConfig } from "../../src/config.js";
import type { CompanionTurn } from "../../src/gateway/companion.js";
import {
  companionWakes,
  controlText,
  mentionsAgent,
  sameAuthor,
} from "../../src/gateway/response-policy.js";

const current: CompanionTurn = {
  identityId: "identity-1",
  handle: "test-agent",
  from: "Sponsor@example.com",
  sourceId: "source-1",
  initialization: false,
  metadata: {
    phase: "live",
    channel: "mail",
    scope_id: "scope-1",
    activation_id: "activation-1",
    conversation_id: "conversation-1",
    sequence: 1,
  },
  emailAddress: "test-agent@example.com",
  rawText: "@agent hi",
  senderAccess: "direct",
};

describe("current-message response policy", () => {
  for (const channel of ["mail", "phone", "imessage"] as const) {
    for (const mode of ["safe", "relaxed"] as const) {
      for (const access of ["direct", "sponsored", undefined, "future"]) {
        for (const addressed of [true, false]) {
          it(`${channel} ${mode} ${access} addressed=${addressed}`, () => {
            const config = {
              ...defaultGatewayConfig(),
              groupReplyMode: "mention" as const,
              companionResponseMode: mode,
            };
            expect(
              companionWakes(
                {
                  ...current,
                  metadata: { ...current.metadata, channel },
                  rawText: addressed ? "@test-agent help" : "just context",
                  senderAccess: access,
                },
                config,
              ),
            ).toBe(addressed && (mode === "relaxed" || access === "direct"));
          });
        }
      }
    }
  }
  it.each(["@agent", "hi @TEST-AGENT!", "@agent, please"])("matches whole mentions: %s", (text) =>
    expect(mentionsAgent(text, "test-agent")).toBe(true),
  );
  it.each([
    "mail@agent.com",
    "@agents",
    "@agent-test",
    "https://example.com/@agent",
    "www.example.com/@test-agent",
    "test-agent@example.com",
  ])("ignores unrelated tokens: %s", (text) =>
    expect(mentionsAgent(text, "test-agent")).toBe(false),
  );
  it("uses current To mailbox but never quoted headers or an unrelated mailbox", () => {
    const config = { ...defaultGatewayConfig(), groupReplyMode: "mention" as const };
    expect(
      companionWakes(
        { ...current, rawText: "hello", toAddresses: ["Agent <TEST-AGENT@example.com>"] },
        config,
      ),
    ).toBe(true);
    expect(
      companionWakes(
        { ...current, rawText: "To: test-agent@example.com", toAddresses: ["other@example.com"] },
        config,
      ),
    ).toBe(false);
    expect(
      companionWakes(
        {
          ...current,
          rawText: "hello",
          senderAccess: "sponsored",
          toAddresses: ["test-agent@example.com"],
        },
        config,
      ),
    ).toBe(false);
  });
  it("normalizes email authors only and strips leading command mentions", () => {
    expect(sameAuthor("email", "Sponsor@Example.com", "sponsor@example.com")).toBe(true);
    expect(sameAuthor("sms", "ABC", "abc")).toBe(false);
    expect(controlText("@test-agent, /stop", "test-agent")).toBe("/stop");
  });
});
