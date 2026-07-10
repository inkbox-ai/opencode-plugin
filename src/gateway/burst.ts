import type { InboundMessage } from "./types.js";

// Humans text in fragments and corrections. Batching fragments that arrive
// within a quiet window into one merged turn keeps a single thought from
// becoming several self-interrupting agent turns.
export const DEFAULT_BURST_MAX_MESSAGES = 8;
export const DEFAULT_BURST_MAX_CHARS = 4000;

export interface BurstBuffer {
  // Queue a message for its chat's pending batch (starting one if needed).
  add(msg: InboundMessage): void;
  // Flush every pending batch immediately (shutdown).
  flushAll(): void;
}

interface Pending {
  msgs: InboundMessage[];
  chars: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createBurstBuffer(opts: {
  windowMs: number;
  maxMessages?: number;
  maxChars?: number;
  deliver(msg: InboundMessage): void;
}): BurstBuffer {
  const maxMessages = opts.maxMessages ?? DEFAULT_BURST_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_BURST_MAX_CHARS;
  const pending = new Map<string, Pending>();

  function flush(chatKey: string): void {
    const batch = pending.get(chatKey);
    if (!batch) return;
    pending.delete(chatKey);
    clearTimeout(batch.timer);
    opts.deliver(mergeBurst(batch.msgs));
  }

  return {
    add(msg) {
      const existing = pending.get(msg.chatKey);
      if (!existing) {
        const timer = setTimeout(() => flush(msg.chatKey), opts.windowMs);
        timer.unref?.();
        pending.set(msg.chatKey, { msgs: [msg], chars: msg.text.length, timer });
        return;
      }
      existing.msgs.push(msg);
      existing.chars += msg.text.length;
      // Sliding quiet window: each fragment restarts the countdown.
      clearTimeout(existing.timer);
      if (existing.msgs.length >= maxMessages || existing.chars >= maxChars) {
        flush(msg.chatKey);
        return;
      }
      existing.timer = setTimeout(() => flush(msg.chatKey), opts.windowMs);
      existing.timer.unref?.();
    },

    flushAll() {
      for (const chatKey of [...pending.keys()]) flush(chatKey);
    },
  };
}

// Collapse a batch into one message: newest metadata (ids, threading), all
// fragment texts in arrival order, and every attachment.
export function mergeBurst(msgs: InboundMessage[]): InboundMessage {
  if (msgs.length === 1) return msgs[0];
  const last = msgs[msgs.length - 1];
  return {
    ...last,
    text: msgs
      .map((m) => m.text)
      .filter((t) => t.trim() !== "")
      .join("\n"),
    mediaPaths: msgs.flatMap((m) => m.mediaPaths),
    burst: msgs.length,
  };
}
