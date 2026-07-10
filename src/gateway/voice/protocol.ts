import type { WebSocket } from "ws";

// Frames Inkbox sends over the call media WebSocket. Raw-media audio arrives
// as an object under `media` (base64 µ-law in `payload`), not a bare string.
export type InkboxCallFrame =
  | { event: "start"; [k: string]: unknown }
  | { event: "transcript"; is_final?: boolean; text?: string; [k: string]: unknown }
  | { event: "media"; media?: { payload?: string } | string; [k: string]: unknown }
  | { event: "stop" | "closed" | "hangup"; [k: string]: unknown };

export function parseFrame(data: unknown): InkboxCallFrame | undefined {
  try {
    const raw = typeof data === "string" ? data : String(data);
    const obj = JSON.parse(raw);
    if (obj && typeof obj.event === "string") return obj as InkboxCallFrame;
  } catch {
    // Non-JSON frame (e.g. a raw binary keepalive) — ignore.
  }
  return undefined;
}

// Extract the base64 µ-law payload from a caller-audio frame. Tolerates the
// object shape (`media.payload`) and a bare-string shape for forward compat.
export function callerAudio(frame: { media?: { payload?: string } | string }): string | undefined {
  const m = frame.media;
  if (typeof m === "string") return m;
  return typeof m?.payload === "string" ? m.payload : undefined;
}

// Speak a turn back to the caller. Two frames: a delta carrying the text,
// then a done frame that flushes speech synthesis and ends the turn.
export function speak(ws: WebSocket, text: string, turnId: string): void {
  ws.send(JSON.stringify({ event: "text", delta: text, turn_id: turnId }));
  ws.send(JSON.stringify({ event: "text", done: true, turn_id: turnId }));
}

// Forward a base64 µ-law audio chunk to the caller (Realtime raw-media mode).
export function sendMedia(ws: WebSocket, base64Ulaw: string): void {
  ws.send(JSON.stringify({ event: "media", media: { payload: base64Ulaw, track: "outbound" } }));
}

// Signal the end of a spoken audio response so the far side flushes playback.
export function sendAudioDone(ws: WebSocket): void {
  ws.send(JSON.stringify({ event: "audio_done" }));
}

// Upgrade-response headers select the call mode. STT/TTS mode asks Inkbox to
// transcribe caller audio and synthesize our text replies; raw-media mode
// (Realtime) turns both off so µ-law frames flow untouched.
export function callModeHeaders(mode: "stt-tts" | "raw-media"): Record<string, string> {
  const on = mode === "stt-tts";
  return {
    "x-use-inkbox-speech-to-text": on ? "true" : "false",
    "x-use-inkbox-text-to-speech": on ? "true" : "false",
  };
}
