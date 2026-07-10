// Fragment-burst batching: rapid texts merge into one turn after a quiet
// window; caps flush immediately; separate chats never mix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBurstBuffer, mergeBurst } from "../../src/gateway/burst.js";
import type { InboundMessage } from "../../src/gateway/types.js";

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "sms",
    chatKey: "ck",
    from: "+15550001111",
    text: "ping",
    mediaPaths: [],
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createBurstBuffer", () => {
  it("merges fragments arriving within the quiet window into one delivery", () => {
    const deliver = vi.fn();
    const buf = createBurstBuffer({ windowMs: 1000, deliver });
    buf.add(msg({ text: "hey" }));
    vi.advanceTimersByTime(500);
    buf.add(msg({ text: "actually wait" }));
    vi.advanceTimersByTime(500);
    expect(deliver).not.toHaveBeenCalled(); // window slid on the second fragment
    vi.advanceTimersByTime(500);
    expect(deliver).toHaveBeenCalledTimes(1);
    const merged = deliver.mock.calls[0][0] as InboundMessage;
    expect(merged.text).toBe("hey\nactually wait");
    expect(merged.burst).toBe(2);
  });

  it("delivers a lone message unmodified after the window", () => {
    const deliver = vi.fn();
    const buf = createBurstBuffer({ windowMs: 1000, deliver });
    buf.add(msg({ text: "solo" }));
    vi.advanceTimersByTime(1000);
    const out = deliver.mock.calls[0][0] as InboundMessage;
    expect(out.text).toBe("solo");
    expect(out.burst).toBeUndefined();
  });

  it("flushes immediately at the message cap", () => {
    const deliver = vi.fn();
    const buf = createBurstBuffer({ windowMs: 60_000, maxMessages: 3, deliver });
    buf.add(msg({ text: "a" }));
    buf.add(msg({ text: "b" }));
    buf.add(msg({ text: "c" }));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0][0] as InboundMessage).burst).toBe(3);
  });

  it("keeps separate chats in separate batches", () => {
    const deliver = vi.fn();
    const buf = createBurstBuffer({ windowMs: 1000, deliver });
    buf.add(msg({ chatKey: "a", text: "one" }));
    buf.add(msg({ chatKey: "b", text: "two" }));
    vi.advanceTimersByTime(1000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("flushAll drains every pending batch", () => {
    const deliver = vi.fn();
    const buf = createBurstBuffer({ windowMs: 60_000, deliver });
    buf.add(msg({ chatKey: "a" }));
    buf.add(msg({ chatKey: "b" }));
    buf.flushAll();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

describe("mergeBurst", () => {
  it("keeps the newest metadata and concatenates media", () => {
    const merged = mergeBurst([
      msg({ messageId: "m1", mediaPaths: ["/a.png"] }),
      msg({ messageId: "m2", text: "and this", mediaPaths: ["/b.png"] }),
    ]);
    expect(merged.messageId).toBe("m2");
    expect(merged.mediaPaths).toEqual(["/a.png", "/b.png"]);
    expect(merged.burst).toBe(2);
  });
});
