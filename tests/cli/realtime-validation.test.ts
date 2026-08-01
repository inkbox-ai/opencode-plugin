import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  type RealtimeSocketFactory,
  validateOpenAIRealtime,
} from "../../src/cli/realtime-validation.js";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  close = vi.fn();
  terminate = vi.fn();

  send(value: string): void {
    this.sent.push(value);
  }
}

describe("OpenAI Realtime setup validation", () => {
  it("opens a real Realtime endpoint and succeeds only after session.updated", async () => {
    const socket = new FakeSocket();
    const factory = vi.fn(((url, options) => {
      expect(url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2");
      expect(options.headers.Authorization).toBe("Bearer sk-valid");
      queueMicrotask(() => {
        socket.emit("open");
        socket.emit("message", Buffer.from(JSON.stringify({ type: "session.created" })));
        socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
      });
      return socket;
    }) as RealtimeSocketFactory);

    await expect(
      validateOpenAIRealtime("sk-valid", "gpt-realtime-2", { socketFactory: factory }),
    ).resolves.toEqual({ ok: true, detail: "OpenAI Realtime session update succeeded." });
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "session.update",
      session: { type: "realtime", model: "gpt-realtime-2" },
    });
  });

  it("reports a Realtime rejection and redacts the key from server errors", async () => {
    const socket = new FakeSocket();
    const resultPromise = validateOpenAIRealtime("sk-secret", "gpt-realtime-2", {
      socketFactory: () => {
        queueMicrotask(() => {
          socket.emit("open");
          socket.emit(
            "message",
            JSON.stringify({
              type: "error",
              error: { code: "invalid_api_key", message: "Rejected sk-secret" },
            }),
          );
        });
        return socket;
      },
    });
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, detail: "invalid_api_key: Rejected ***" });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("fails within the bounded timeout when Realtime never responds", async () => {
    const socket = new FakeSocket();
    const result = await validateOpenAIRealtime("sk-timeout", "gpt-realtime-2", {
      timeoutMs: 5,
      socketFactory: () => socket,
    });
    expect(result).toEqual({
      ok: false,
      detail: "Timed out waiting for an OpenAI Realtime session response.",
    });
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
