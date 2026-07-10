import { describe, expect, it, vi } from "vitest";
import {
  callerAudio,
  callModeHeaders,
  parseFrame,
  sendAudioDone,
  sendMedia,
  speak,
} from "../../src/gateway/voice/protocol.js";

function fakeWs() {
  const sent: string[] = [];
  return { sent, ws: { send: vi.fn((s: string) => sent.push(s)) } as any };
}

describe("call media protocol", () => {
  it("extracts caller audio from the object payload shape", () => {
    expect(callerAudio({ media: { payload: "AAAA" } })).toBe("AAAA");
    expect(callerAudio({ media: "BBBB" })).toBe("BBBB");
    expect(callerAudio({ media: {} })).toBeUndefined();
    expect(callerAudio({})).toBeUndefined();
  });

  it("sends outbound audio as an object payload on the outbound track", () => {
    const { ws, sent } = fakeWs();
    sendMedia(ws, "Zm9v");
    expect(JSON.parse(sent[0])).toEqual({
      event: "media",
      media: { payload: "Zm9v", track: "outbound" },
    });
  });

  it("flushes playback with an audio_done frame", () => {
    const { ws, sent } = fakeWs();
    sendAudioDone(ws);
    expect(JSON.parse(sent[0])).toEqual({ event: "audio_done" });
  });

  it("speaks a turn as a text delta followed by a done frame", () => {
    const { ws, sent } = fakeWs();
    speak(ws, "hello", "t1");
    expect(JSON.parse(sent[0])).toEqual({ event: "text", delta: "hello", turn_id: "t1" });
    expect(JSON.parse(sent[1])).toEqual({ event: "text", done: true, turn_id: "t1" });
  });

  it("selects Inkbox speech vs raw-media via upgrade headers", () => {
    expect(callModeHeaders("stt-tts")).toEqual({
      "x-use-inkbox-speech-to-text": "true",
      "x-use-inkbox-text-to-speech": "true",
    });
    expect(callModeHeaders("raw-media")).toEqual({
      "x-use-inkbox-speech-to-text": "false",
      "x-use-inkbox-text-to-speech": "false",
    });
  });

  it("parses JSON frames and ignores non-JSON", () => {
    expect(parseFrame('{"event":"start"}')).toEqual({ event: "start" });
    expect(parseFrame("not json")).toBeUndefined();
  });
});
