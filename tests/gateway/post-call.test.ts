// Post-call prompts must carry the counterparty's contact card so queued
// follow-ups ("email me after") reach real addresses, not guessed ones.
import { describe, expect, it } from "vitest";
import { callEndedPrompt, postCallPrompt } from "../../src/gateway/voice/post-call.js";

const CALLER = "from=+15550001111 | contact_id=c-1 contact_emails=ada@example.com";

describe("postCallPrompt", () => {
  it("includes the caller card ahead of the queued actions", () => {
    const prompt = postCallPrompt([{ id: "a1", description: "email the summary" }], "", CALLER);
    expect(prompt).toContain(`The call was with: [inkbox:voice ${CALLER}]`);
    expect(prompt.indexOf("The call was with")).toBeLessThan(prompt.indexOf("Queued actions:"));
    expect(prompt).toContain("1. email the summary");
  });

  it("omits the caller line when no caller is known", () => {
    const prompt = postCallPrompt([{ id: "a1", description: "x" }], "");
    expect(prompt).not.toContain("The call was with");
  });
});

describe("callEndedPrompt", () => {
  it("includes the caller card with the transcript", () => {
    const prompt = callEndedPrompt("caller: hi", CALLER);
    expect(prompt).toContain(`The call was with: [inkbox:voice ${CALLER}]`);
    expect(prompt).toContain("caller: hi");
  });
});
