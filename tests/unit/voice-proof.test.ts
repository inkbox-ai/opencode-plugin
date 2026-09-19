import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  containsVoiceMarker,
  hasAfterCallSmsIntent,
  hasSmsIntent,
  hostedCallerReadiness,
  hostedReadbackReadiness,
  hostedSmsDeliveryEvidence,
  normalizedVoiceTokens,
  smsIntentEvidence,
  voiceMarkerEvidence,
  wasAcceptedForDelivery,
} from "../live/voice-proof.js";

describe("hosted live voice proof normalization", () => {
  it("keeps the actual hosted request natural without telling the agent how to fulfill it", () => {
    const workflow = readFileSync(".github/workflows/live-voice.yml", "utf8");
    const template = workflow.match(/export VOICE_DRIVER_LINE="([^"]+)"/)?.[1];
    if (!template) throw new Error("Hosted workflow request is missing");
    const marker = "zulu alpha bravo";
    const request = template.replaceAll("$HOSTED_MARKER", marker);
    expect(request.split(marker)).toHaveLength(2);
    expect(request).toContain(
      `After we hang up, send me one SMS containing exactly these three words: ${marker}`,
    );
    expect(request).toContain("Please repeat the three words back so I know you heard them.");
    expect(request).not.toMatch(/\b(?:action|tool|register|title|details|saving)\b|inkbox_/i);
    expect(hostedCallerReadiness(request, request, marker).callerReady).toBe(true);
    expect(hostedCallerReadiness(request, "Do not text during this call", marker).callerReady).toBe(
      false,
    );
  });

  it("requires the marker readback to be both spoken by the agent and heard by the caller", () => {
    const marker = "zulu alpha bravo";
    expect(hostedReadbackReadiness(marker, marker, marker).readbackReady).toBe(true);
    expect(hostedReadbackReadiness(marker, "hello", marker).readbackReady).toBe(false);
    expect(hostedReadbackReadiness("hello", marker, marker).readbackReady).toBe(false);
    expect(hostedReadbackReadiness("hello", "hello", marker).readbackReady).toBe(false);
  });

  it("requires one whole-body, journal-matched SMS sent only after the call ended", () => {
    const proof = (
      messages: Parameters<typeof hostedSmsDeliveryEvidence>[0],
      marker: string,
      endedAt: Date | null,
      ids: string[],
    ) => hostedSmsDeliveryEvidence(messages, marker, endedAt, ids, "+15555550123");
    const endedAt = new Date("2026-01-01T12:00:00Z");
    const message = {
      id: "current",
      remotePhoneNumber: "+15555550123",
      text: "Zulu, alpha bravo.",
      createdAt: new Date("2026-01-01T12:00:01Z"),
      deliveryStatus: "delivered",
    };
    expect(proof([message], "zulu alpha bravo", endedAt, ["current"]).complete).toBe(true);
    for (const text of [
      "Here are the words zulu alpha bravo",
      "zulu alpha bravo confirmed",
      "zulu bravo alpha",
      "zulu alpha",
      "zulualpha bravo",
    ]) {
      expect(proof([{ ...message, text }], "zulu alpha bravo", endedAt, ["current"]).complete).toBe(
        false,
      );
    }
    expect(proof([message], "", endedAt, ["current"]).complete).toBe(false);
    expect(proof([message], "zulu alpha bravo", endedAt, ["different"]).complete).toBe(false);
    expect(proof([message], "zulu alpha bravo", null, ["current"]).complete).toBe(false);
    expect(
      proof(
        [{ ...message, createdAt: new Date("2026-01-01T11:59:59Z") }],
        "zulu alpha bravo",
        endedAt,
        ["current"],
      ).complete,
    ).toBe(false);
    expect(
      proof(
        [message, { ...message, id: "extra", text: "I will call you now" }],
        "zulu alpha bravo",
        endedAt,
        ["current"],
      ).complete,
    ).toBe(false);
    expect(
      proof([{ ...message, deliveryStatus: "blocked_spam_filter" }], "zulu alpha bravo", endedAt, [
        "current",
      ]).complete,
    ).toBe(false);
    expect(
      proof([{ ...message, remotePhoneNumber: "+15555550999" }], "zulu alpha bravo", endedAt, [
        "current",
      ]).complete,
    ).toBe(false);
    expect(
      proof(
        [{ ...message, recipients: [{ recipientPhoneNumber: "+15555550999" }] }],
        "zulu alpha bravo",
        endedAt,
        ["current"],
      ).complete,
    ).toBe(false);
    expect(
      proof(
        [message, { ...message, id: "wrong-target", remotePhoneNumber: "+15555550999" }],
        "zulu alpha bravo",
        endedAt,
        ["current"],
      ).complete,
    ).toBe(false);
  });

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
