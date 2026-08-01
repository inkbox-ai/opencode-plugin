import { describe, expect, it } from "vitest";
import {
  containsVoiceMarker,
  hasAfterCallSmsIntent,
  hasSmsIntent,
  normalizedVoiceTokens,
} from "../live/voice-proof.js";

describe("hosted live voice proof normalization", () => {
  it("normalizes punctuation without accepting reordered marker words", () => {
    expect(normalizedVoiceTokens("Zulu, Alpha-Bravo! 42")).toEqual([
      "zulu",
      "alpha",
      "bravo",
      "42",
    ]);
    expect(containsVoiceMarker("marker: zulu, alpha—bravo", "zulu alpha bravo")).toBe(true);
    expect(containsVoiceMarker("zulu bravo alpha", "zulu alpha bravo")).toBe(false);
  });

  it("requires both after-call timing and an SMS intent for caller evidence", () => {
    expect(hasAfterCallSmsIntent("After we hang up, send me an SMS with the marker.")).toBe(true);
    expect(hasAfterCallSmsIntent("Send me an SMS now.")).toBe(false);
    expect(hasAfterCallSmsIntent("After the call ends, remember the marker.")).toBe(false);
  });

  it("recognizes open-action SMS wording independently of timing", () => {
    expect(hasSmsIntent("Send a text message containing the marker after the call.")).toBe(true);
    expect(hasSmsIntent("Review the text-message history.")).toBe(false);
  });
});
