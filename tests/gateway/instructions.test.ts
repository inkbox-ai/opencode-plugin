// Voice-call system instructions: identity, caller card, direction-specific
// guidance, and tool choreography — everything the spoken model gets per call.
import { describe, expect, it } from "vitest";
import {
  buildVoiceGreeting,
  buildVoiceInstructions,
  type CallMeta,
} from "../../src/gateway/voice/instructions.js";

function meta(over: Partial<CallMeta> = {}): CallMeta {
  return {
    callId: "call-1",
    direction: "inbound",
    from: "+15550001111",
    contact: {},
    identity: {
      handle: "test-agent",
      emailAddress: "agent@example.com",
      dedicatedNumber: "+15559990000",
      imessageEnabled: true,
    },
    ...over,
  };
}

describe("buildVoiceInstructions", () => {
  it("includes the agent's own identity block", () => {
    const out = buildVoiceInstructions(meta());
    expect(out).toContain("identity handle: test-agent");
    expect(out).toContain("agent@example.com");
    expect(out).toContain("+15559990000");
    expect(out).toContain("shared Inkbox iMessage line");
  });

  it("injects the known caller's full card and a no-lookup directive", () => {
    const out = buildVoiceInstructions(
      meta({
        contact: {
          contactId: "c-1",
          contactName: "Ada Lovelace",
          contactEmails: ["ada@example.com"],
          contactPhones: ["+15550001111"],
          contactCompany: "Analytical Engines",
          contactNotes: "Prefers morning calls.",
        },
      }),
    );
    expect(out).toContain("do NOT look them up");
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("ada@example.com");
    expect(out).toContain("Analytical Engines");
    expect(out).toContain("Prefers morning calls.");
  });

  it("tells the model it does not know an unresolved caller", () => {
    const out = buildVoiceInstructions(meta({ contact: {} }));
    expect(out).toContain("you do NOT know who this is");
    expect(out).toContain("Greet them neutrally");
  });

  it("adds outbound purpose, opening, and no-generic-greeting guidance", () => {
    const out = buildVoiceInstructions(
      meta({ direction: "outbound", purpose: "confirm the invoice", openingMessage: "Hi Ada!" }),
    );
    expect(out).toContain("outbound call you placed. Purpose: confirm the invoice");
    expect(out).toContain("Hi Ada!");
    expect(out).toContain("do not open with a generic offer to help");
  });

  it("covers tool choreography: consult scope, post-call actions, two-step hangup", () => {
    const out = buildVoiceInstructions(meta());
    expect(out).toContain("consult_agent");
    expect(out).toContain("Do not promise work outside that list");
    expect(out).toContain("register_post_call_action");
    expect(out).toContain("hang_up_call");
    expect(out).toContain("third parties");
  });
});

describe("buildVoiceGreeting", () => {
  it("greets a known inbound caller by name", () => {
    const out = buildVoiceGreeting(meta({ contact: { contactId: "c-1", contactName: "Ada" } }));
    expect(out).toContain("(Ada)");
  });

  it("greets an unknown inbound caller neutrally", () => {
    expect(buildVoiceGreeting(meta())).toContain("neutrally");
  });

  it("leads outbound calls with the opening message", () => {
    const out = buildVoiceGreeting(meta({ direction: "outbound", openingMessage: "Hey Alex!" }));
    expect(out).toContain("Hey Alex!");
  });

  it("falls back to the purpose when outbound has no opening message", () => {
    const out = buildVoiceGreeting(meta({ direction: "outbound", purpose: "confirm dinner" }));
    expect(out).toContain("confirm dinner");
  });
});
