import { describe, expect, it } from "vitest";
import {
  containsVoiceMarker,
  hasAfterCallSmsIntent,
  hasSmsIntent,
  hostedCallerReadiness,
  normalizedVoiceTokens,
  smsIntentEvidence,
  voiceMarkerEvidence,
  wasAcceptedForDelivery,
} from "../live/voice-proof.js";

describe("hosted live voice proof normalization", () => {
  it("reports action lexical evidence without disclosing action text", () => {
    const evidence = smsIntentEvidence(["Send S.M.S. private-content"]);
    expect(evidence).toEqual({
      rows: 1,
      sendVerbRows: 1,
      smsRows: 0,
      spelledSmsRows: 1,
      textRows: 0,
      recognizedRows: 1,
      maxWords: 6,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-content");
    expect(smsIntentEvidence([]).maxWords).toBe(0);
  });

  it("requires the full caller request in both call legs, not just the driver recording", () => {
    const complete = "After we hang up, send me an SMS saying zulu alpha bravo.";
    const clipped = "After we hang up, send me an SMS saying zulu alpha.";
    expect(hostedCallerReadiness(complete, clipped, "zulu alpha bravo")).toEqual({
      callerReady: false,
      driverCallerReady: true,
      autCallerReady: false,
    });
    expect(hostedCallerReadiness(clipped, complete, "zulu alpha bravo").callerReady).toBe(false);
    expect(hostedCallerReadiness(complete, complete, "zulu alpha bravo").callerReady).toBe(true);
  });

  it("reports missing, incomplete, and reordered evidence without disclosing content", () => {
    const marker = "zulu alpha bravo";
    expect(voiceMarkerEvidence([], marker)).toEqual({
      rows: 0,
      exactMarkerRows: 0,
      maxMatchedWords: 0,
    });
    expect(voiceMarkerEvidence(["private content: zulu alpha alpha"], marker)).toEqual({
      rows: 1,
      exactMarkerRows: 0,
      maxMatchedWords: 2,
    });
    expect(voiceMarkerEvidence(["zulu bravo alpha"], marker)).toEqual({
      rows: 1,
      exactMarkerRows: 0,
      maxMatchedWords: 3,
    });
    const evidence = voiceMarkerEvidence(["private content: zulu, alpha—bravo"], marker);
    expect(evidence).toEqual({ rows: 1, exactMarkerRows: 1, maxMatchedWords: 3 });
    expect(JSON.stringify(evidence)).not.toMatch(/private|content|zulu|alpha|bravo/);
  });

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

  it.each(["S M S", "S.M.S.", "S-M-S"])(
    "recognizes the spoken acronym %s without dropping the send requirement",
    (acronym) => {
      expect(hasSmsIntent(`Send ${acronym} zulu alpha bravo`)).toBe(true);
      expect(hasAfterCallSmsIntent(`After we hang up, send me ${acronym} zulu alpha bravo`)).toBe(
        true,
      );
      expect(hasSmsIntent(`Review ${acronym} history`)).toBe(false);
    },
  );

  it.each(["Send S M X", "Send S M system", "Send ASM S", "Send S MMS"])(
    "does not turn unrelated letters into SMS intent: %s",
    (value) => expect(hasSmsIntent(value)).toBe(false),
  );

  it("does not count a pre-delivery policy block as an accepted SMS", () => {
    expect(wasAcceptedForDelivery({ deliveryStatus: "blocked_spam_filter" })).toBe(false);
    expect(wasAcceptedForDelivery({ delivery_status: "blocked_spam_filter" })).toBe(false);
    expect(wasAcceptedForDelivery({ deliveryStatus: "queued" })).toBe(true);
    expect(wasAcceptedForDelivery({ deliveryStatus: "delivered" })).toBe(true);
    expect(wasAcceptedForDelivery({ deliveryStatus: "delivery_failed" })).toBe(true);
    expect(wasAcceptedForDelivery({ deliveryStatus: "sending_failed" })).toBe(true);
    expect(wasAcceptedForDelivery({})).toBe(true);
  });
});
