import type { WebSocket } from "ws";

// Frames Inkbox sends over the call media WebSocket.
export type InkboxCallFrame =
  | { event: "start"; [k: string]: unknown }
  | { event: "transcript"; is_final?: boolean; text?: string; [k: string]: unknown }
  | { event: "media"; media?: string; [k: string]: unknown }
  | { event: "stop"; [k: string]: unknown };

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

// Speak a turn back to the caller. Two frames: a delta carrying the text,
// then a done frame that flushes speech synthesis and ends the turn.
export function speak(ws: WebSocket, text: string, turnId: string): void {
  ws.send(JSON.stringify({ event: "text", delta: text, turn_id: turnId }));
  ws.send(JSON.stringify({ event: "text", done: true, turn_id: turnId }));
}

// Forward a base64 μ-law audio chunk to the caller (Realtime raw-media mode).
export function sendMedia(ws: WebSocket, base64Ulaw: string): void {
  ws.send(JSON.stringify({ event: "media", media: base64Ulaw }));
}

// Upgrade-response headers select the call mode. STT/TTS mode asks Inkbox to
// transcribe caller audio and synthesize our text replies; raw-media mode
// (Realtime) turns both off so μ-law frames flow untouched.
export function callModeHeaders(mode: "stt-tts" | "raw-media"): Record<string, string> {
  const on = mode === "stt-tts";
  return {
    "x-use-inkbox-speech-to-text": on ? "true" : "false",
    "x-use-inkbox-text-to-speech": on ? "true" : "false",
  };
}
