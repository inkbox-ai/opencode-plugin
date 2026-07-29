// Post-call prompts must carry the counterparty's contact card so queued
// follow-ups ("email me after") reach real addresses, not guessed ones.
import { describe, expect, it } from "vitest";
import { callEndedPrompt, postCallPrompt } from "../../src/gateway/voice/post-call.js";

const CALLER = "from=+15550001111 | contact_id=c-1 contact_emails=ada@example.com";

describe("postCallPrompt", () => {
  it("includes the caller card ahead of the queued actions", () => {
    const prompt = postCallPrompt([{ id: "a1", description: "email the summary" }], "", CALLER);
    expect(prompt.startsWith(`[inkbox:voice ${CALLER}]`)).toBe(true);
    expect(prompt.indexOf("[inkbox:voice")).toBeLessThan(prompt.indexOf("Queued actions:"));
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
    expect(prompt.startsWith(`[inkbox:voice ${CALLER}]`)).toBe(true);
    expect(prompt).toContain("caller: hi");
  });

  it("places memories between the routing marker and transcript", () => {
    const prompt = callEndedPrompt("caller: hi", CALLER, ["Asked about a renewal."]);
    expect(prompt.indexOf("[inkbox:voice")).toBe(0);
    expect(prompt.indexOf("[inkbox:contact_memories]")).toBeGreaterThan(0);
    expect(prompt.indexOf("[inkbox:contact_memories]")).toBeLessThan(prompt.indexOf("caller: hi"));
  });
});
