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
