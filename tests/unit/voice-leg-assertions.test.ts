import { describe, expect, it, vi } from "vitest";
import { waitDriverLocalSpeech, waitTwoWayCall } from "../live/helpers.js";

function ownerWithTranscript(segments: Array<{ party: string; text: string }>) {
  return {
    calls: {
      transcripts: vi.fn().mockResolvedValue(segments),
      get: vi.fn(),
    },
  };
}

describe("live voice leg ownership", () => {
  it("requires two parties on the AUT owner and returns AUT-local agent speech", async () => {
    const aut = ownerWithTranscript([
      { party: "remote", text: "caller request" },
      { party: "local", text: "agent answer" },
    ]);

    await expect(waitTwoWayCall(aut as never, "current-aut-call", 100)).resolves.toBe(
      "agent answer",
    );
    expect(aut.calls.get).not.toHaveBeenCalled();
  });

  it("reports missing party and call mode without exposing transcript content", async () => {
    vi.useFakeTimers();
    try {
      const aut = ownerWithTranscript([{ party: "local", text: "private transcript sentinel" }]);
      aut.calls.get.mockResolvedValue({
        status: "answered",
        useInkboxTts: true,
        useInkboxStt: true,
      });
      const result = waitTwoWayCall(aut as never, "private-call-id", 1).catch(
        (error: Error) => error,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('"remoteSegments":0,"localSegments":1');
      expect(message).toContain('"transcriptReadable":true,"callReadable":true');
      expect(message).toContain('"status":"answered","useInkboxTts":true,"useInkboxStt":true');
      expect(message).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only local speech as proof on the driver-owned leg", async () => {
    const driver = ownerWithTranscript([
      { party: "local", text: "scripted caller line" },
      { party: "remote", text: "mirrored agent audio" },
    ]);

    await expect(waitDriverLocalSpeech(driver as never, "current-driver-call", 100)).resolves.toBe(
      "scripted caller line",
    );
    expect(driver.calls.get).not.toHaveBeenCalled();
  });
});
