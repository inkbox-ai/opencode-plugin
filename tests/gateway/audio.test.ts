import { describe, expect, it } from "vitest";
import { CallAudio, callAudioFormat } from "../../src/gateway/voice/audio.js";

describe("negotiated call audio", () => {
  it("selects wideband and legacy descriptors and rejects unsupported media", () => {
    expect(
      callAudioFormat({ media_format: { encoding: "L16", sample_rate: 16000, channels: 1 } }),
    ).toBe("pcm_s16le_16000");
    expect(
      callAudioFormat({ media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } }),
    ).toBe("pcmu_8000");
    expect(callAudioFormat(undefined)).toBe("pcmu_8000");
    expect(() =>
      callAudioFormat({ media_format: { encoding: "L16", sample_rate: 16000, channels: 2 } }),
    ).toThrow("Unsupported");
  });

  it("converts wideband silence in both directions and flushes the response tail", () => {
    const audio = new CallAudio();
    const input = Buffer.from(audio.toRealtime(Buffer.alloc(3200).toString("base64")), "base64");
    expect(input.length).toBeGreaterThan(4600);
    expect(input.equals(Buffer.alloc(input.length))).toBe(true);
    const output = Buffer.concat([
      Buffer.from(audio.fromRealtime(Buffer.alloc(4800).toString("base64")), "base64"),
      Buffer.from(audio.finishOutput(), "base64"),
    ]);
    expect(output).toEqual(Buffer.alloc(3200));
    expect(audio.finishOutput()).toBe("");
  });

  it("decodes and encodes legacy silence without misinterpreting it as PCM", () => {
    const audio = new CallAudio("pcmu_8000");
    const input = Buffer.from(
      audio.toRealtime(Buffer.alloc(800, 255).toString("base64")),
      "base64",
    );
    expect(input.length).toBeGreaterThan(4500);
    expect(input.equals(Buffer.alloc(input.length))).toBe(true);
    const output = Buffer.concat([
      Buffer.from(audio.fromRealtime(Buffer.alloc(4800).toString("base64")), "base64"),
      Buffer.from(audio.finishOutput(), "base64"),
    ]);
    expect(output).toEqual(Buffer.alloc(800, 255));
  });

  it("discards buffered response audio on interruption", () => {
    const audio = new CallAudio();
    audio.fromRealtime(Buffer.alloc(32, 127).toString("base64"));
    audio.interrupt();
    expect(audio.finishOutput()).toBe("");
  });
});
