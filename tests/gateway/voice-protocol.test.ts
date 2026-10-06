import { describe, expect, it, vi } from "vitest";
import {
  callerAudio,
  callModeHeaders,
  parseFrame,
  sendAudioDone,
  sendClear,
  sendMedia,
  sendTranscript,
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

  it("publishes final caller and agent transcripts with ownership-relative parties", () => {
    const { ws, sent } = fakeWs();
    Object.assign(ws, { OPEN: 1, readyState: 1 });
    const failed = vi.fn();
    expect(sendTranscript(ws, "remote", " caller request ", failed)).toBe(true);
    expect(sendTranscript(ws, "local", "spoken answer", failed)).toBe(true);
    expect(sent.map((value) => JSON.parse(value))).toEqual([
      { event: "transcript", party: "remote", text: "caller request", is_final: true },
      { event: "transcript", party: "local", text: "spoken answer", is_final: true },
    ]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("does not send empty or closed-socket transcripts and never retries a failed send", () => {
    const { ws, sent } = fakeWs();
    Object.assign(ws, { OPEN: 1, readyState: 3 });
    const failed = vi.fn();
    expect(sendTranscript(ws, "remote", "request", failed)).toBe(false);
    ws.readyState = 1;
    expect(sendTranscript(ws, "local", "   ", failed)).toBe(false);
    expect(sent).toEqual([]);
    ws.send.mockImplementationOnce(() => {
      throw new Error("socket closed");
    });
    expect(sendTranscript(ws, "local", "answer", failed)).toBe(false);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    ws.send.mockImplementationOnce((_value: string, done: (error: Error) => void) => {
      done(new Error("write failed"));
    });
    expect(sendTranscript(ws, "local", "later answer", failed)).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("drops queued playback with a clear frame on barge-in", () => {
    const { ws, sent } = fakeWs();
    sendClear(ws);
    expect(JSON.parse(sent[0])).toEqual({ event: "clear" });
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
      "x-inkbox-audio-format": "pcm_s16le_16000",
      "x-use-inkbox-speech-to-text": "false",
      "x-use-inkbox-text-to-speech": "false",
    });
  });

  it("parses JSON frames and ignores non-JSON", () => {
    expect(parseFrame('{"event":"start"}')).toEqual({ event: "start" });
    expect(parseFrame("not json")).toBeUndefined();
  });
});
