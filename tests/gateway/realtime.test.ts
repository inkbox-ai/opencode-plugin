import { describe, expect, it, vi } from "vitest";
import { createPostCallRegistry } from "../../src/gateway/voice/post-call.js";
import { openRealtimeBridge } from "../../src/gateway/voice/realtime.js";

// A scriptable fake of the OpenAI Realtime socket: capture sends, and let the
// test drive inbound events through the registered "message" handler.
function fakeSocket() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const sent: any[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    on(event: string, cb: (arg: unknown) => void) {
      handlers[event] = cb;
    },
    send(s: string) {
      sent.push(JSON.parse(s));
    },
    close() {},
  };
  return { ws, sent, emit: (e: string, a?: unknown) => handlers[e]?.(a), handlers };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function emitMessage(fake: ReturnType<typeof fakeSocket>, obj: unknown) {
  fake.emit("message", JSON.stringify(obj));
}

describe("realtime session configuration", () => {
  it("sends a GA session.update and resolves ready only on session.updated", async () => {
    const fake = fakeSocket();
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "test-model", voice: "test-voice", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onConsult: vi.fn(async () => ""), onHangup: vi.fn(), logger },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    const update = fake.sent[0];
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("realtime");
    expect(update.session.model).toBe("test-model");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.output.voice).toBe("test-voice");

    let settled = false;
    void bridge.ready.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // open alone is not readiness
    emitMessage(fake, { type: "session.updated" });
    await bridge.ready;
  });

  it("dispatches barge-in when the caller starts speaking", async () => {
    const fake = fakeSocket();
    const onBargeIn = vi.fn();
    openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onBargeIn, onConsult: vi.fn(async () => ""), onHangup: vi.fn(), logger },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "input_audio_buffer.speech_started" });
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it("rejects ready when the API refuses the session after open", async () => {
    const fake = fakeSocket();
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onConsult: vi.fn(async () => ""), onHangup: vi.fn(), logger },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "error", error: { message: "no longer supported" } });
    await expect(bridge.ready).rejects.toThrow(/no longer supported/);
  });
});

describe("realtime function-call lifecycle", () => {
  it("accumulates name + call id + args across the three events before dispatching", async () => {
    const fake = fakeSocket();
    const onConsult = vi.fn(async () => "the answer");
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onConsult, onHangup: vi.fn(), logger },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "session.updated" });
    await bridge.ready;

    // name arrives on output_item.added; args stream via delta; done dispatches.
    emitMessage(fake, {
      type: "response.output_item.added",
      item_id: "it-1",
      item: { type: "function_call", call_id: "call-1", name: "consult_agent" },
    });
    emitMessage(fake, {
      type: "response.function_call_arguments.delta",
      item_id: "it-1",
      delta: '{"query":"what is my balance"}',
    });
    // The done event carries neither name nor args — the accumulated entry is
    // what must drive the dispatch.
    emitMessage(fake, { type: "response.function_call_arguments.done", item_id: "it-1" });
    await new Promise((r) => setTimeout(r, 0));
    // consult ran with the query assembled from the earlier events.
    expect(onConsult).toHaveBeenCalledWith("what is my balance");
    // and the result was returned to the model as a function_call_output.
    expect(fake.sent.some((s) => s.type === "conversation.item.create")).toBe(true);
  });

  it("dispatches a hang_up_call with two-step arming", async () => {
    const fake = fakeSocket();
    const onHangup = vi.fn();
    let clock = 0;
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onConsult: vi.fn(async () => ""), onHangup, logger },
      () => clock,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "session.updated" });
    await bridge.ready;

    const hangup = () => {
      emitMessage(fake, {
        type: "response.output_item.added",
        item_id: `it-${clock}`,
        item: { type: "function_call", call_id: `c-${clock}`, name: "hang_up_call" },
      });
      emitMessage(fake, {
        type: "response.function_call_arguments.done",
        item_id: `it-${clock}`,
      });
    };
    hangup();
    expect(onHangup).not.toHaveBeenCalled(); // first press only arms
    clock = 1000;
    hangup();
    expect(onHangup).toHaveBeenCalledTimes(1); // second press within window ends the call
  });

  it("rejects ready when the socket closes before opening", async () => {
    const fake = fakeSocket();
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      { onAudio: vi.fn(), onConsult: vi.fn(async () => ""), onHangup: vi.fn(), logger },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("close");
    await expect(bridge.ready).rejects.toThrow(/before the session was established/);
  });
});
