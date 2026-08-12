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
    close: vi.fn(),
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
  function toolCall(
    fake: ReturnType<typeof fakeSocket>,
    itemId: string,
    callId: string,
    name: string,
    args = "{}",
  ) {
    emitMessage(fake, {
      type: "response.output_item.added",
      item_id: itemId,
      item: { type: "function_call", call_id: callId, name },
    });
    emitMessage(fake, {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      arguments: args,
    });
  }

  it("captures completed caller and agent transcripts", () => {
    const fake = fakeSocket();
    const onTranscript = vi.fn();
    openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      {
        onAudio: vi.fn(),
        onTranscript,
        onConsult: vi.fn(async () => ""),
        onHangup: vi.fn(),
        logger,
      },
      () => 0,
      () => fake.ws as never,
    );

    emitMessage(fake, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "do this after the call",
    });
    emitMessage(fake, {
      type: "response.output_audio_transcript.done",
      transcript: "I queued it",
    });

    expect(onTranscript).toHaveBeenNthCalledWith(1, "caller", "do this after the call");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "agent", "I queued it");
  });

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

  it("defers hangup until a pending contact result response is complete and flushed", async () => {
    const fake = fakeSocket();
    const onHangup = vi.fn();
    let resolveContact!: (value: string) => void;
    const onContactRead = vi.fn(() => new Promise<string>((resolve) => (resolveContact = resolve)));
    let clock = 0;
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      {
        onAudio: vi.fn(),
        onAudioDone: vi.fn(),
        onConsult: vi.fn(async () => ""),
        onContactRead,
        onHangup,
        logger,
      },
      () => clock,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "session.updated" });
    await bridge.ready;

    toolCall(fake, "contact-item", "contact-call", "inkbox_list_contacts", '{"q":"ada"}');
    toolCall(fake, "hangup-item-1", "hangup-call-1", "hang_up_call");
    clock = 1000;
    toolCall(fake, "hangup-item-2", "hangup-call-2", "hang_up_call");
    expect(onHangup).not.toHaveBeenCalled();

    // The first response belongs to the armed-goodbye result. The second is
    // the contact result and is the one that must drain before hangup.
    emitMessage(fake, { type: "response.created", response: { id: "goodbye-response" } });
    resolveContact("Ada's email is ada@example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitMessage(fake, { type: "response.created", response: { id: "contact-response" } });
    emitMessage(fake, {
      type: "response.output_audio_transcript.done",
      response_id: "contact-response",
      transcript: "Ada's email is ada@example.com",
    });
    emitMessage(fake, {
      type: "response.output_audio.done",
      response_id: "contact-response",
    });
    expect(onHangup).not.toHaveBeenCalled();
    emitMessage(fake, {
      type: "response.done",
      response: { id: "contact-response", status: "completed" },
    });
    expect(onHangup).toHaveBeenCalledTimes(1);

    // Duplicate completion events cannot end the call twice.
    emitMessage(fake, {
      type: "response.done",
      response: { id: "contact-response", status: "completed" },
    });
    expect(onHangup).toHaveBeenCalledTimes(1);
    await bridge.close();
    expect(fake.ws.close).toHaveBeenCalledTimes(1);
  });

  it("closes immediately and idempotently when the call ends during async work", async () => {
    const fake = fakeSocket();
    let resolveConsult!: (value: string) => void;
    const bridge = openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      {
        onAudio: vi.fn(),
        onConsult: vi.fn(() => new Promise<string>((resolve) => (resolveConsult = resolve))),
        onHangup: vi.fn(),
        logger,
      },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, { type: "session.updated" });
    await bridge.ready;
    toolCall(fake, "consult-item", "consult-call", "consult_agent", '{"query":"wait"}');

    await bridge.close();
    await bridge.close();
    expect(fake.ws.close).toHaveBeenCalledTimes(1);

    const sentBeforeLateResult = fake.sent.length;
    resolveConsult("late result");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent).toHaveLength(sentBeforeLateResult);
  });

  it("answers contact-read tools directly via onContactRead", async () => {
    const fake = fakeSocket();
    const onContactRead = vi.fn(async (kind: string) => `cards for ${kind}`);
    openRealtimeBridge(
      { apiKey: "k", model: "m", voice: "v", instructions: "hi" },
      createPostCallRegistry(),
      {
        onAudio: vi.fn(),
        onConsult: vi.fn(async () => ""),
        onContactRead,
        onHangup: vi.fn(),
        logger,
      },
      () => 0,
      () => fake.ws as never,
    );
    fake.emit("open");
    emitMessage(fake, {
      type: "response.output_item.added",
      item_id: "it-9",
      item: { type: "function_call", call_id: "c-9", name: "inkbox_list_contacts" },
    });
    emitMessage(fake, {
      type: "response.function_call_arguments.delta",
      item_id: "it-9",
      delta: '{"q":"ada"}',
    });
    emitMessage(fake, { type: "response.function_call_arguments.done", item_id: "it-9" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onContactRead).toHaveBeenCalledWith("list", { q: "ada" });
    const out = fake.sent.find((s) => s.type === "conversation.item.create");
    expect(out.item.output).toBe("cards for list");
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
