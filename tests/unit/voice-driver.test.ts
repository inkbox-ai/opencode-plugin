import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DriverSocket = {
  accept(options: unknown): Promise<void>;
  send(raw: string): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<string>;
};

const tunnel = vi.hoisted(() => ({
  handler: undefined as undefined | ((socket: DriverSocket) => Promise<void>),
}));

vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));
vi.mock("@inkbox/sdk", () => ({
  Inkbox: class {
    mailboxes = { list: async () => [{ emailAddress: "driver@example.com" }] };
    phoneNumbers = { list: async () => [{ id: "number-1", number: "+15555550123" }] };
    getIdentity = async () => ({ setIncomingCallAction: async () => {} });
  },
}));
vi.mock("@inkbox/sdk/tunnels/connect", () => ({
  connect: async (_client: unknown, options: { wsHandler: typeof tunnel.handler }) => {
    tunnel.handler = options.wsHandler;
    return { tunnel: { publicHost: "driver.example.com" }, wait: async () => {} };
  },
}));

class Socket implements DriverSocket {
  frames: Record<string, unknown>[] = [];
  private queued: string[] = [];
  private pending?: (value: IteratorResult<string>) => void;

  async accept(_options: unknown) {}
  async close() {}
  async send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  push(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve({ value: raw, done: false });
    } else {
      this.queued.push(raw);
    }
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  next(): Promise<IteratorResult<string>> {
    const value = this.queued.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
  spoken() {
    return this.frames.filter((frame) => frame.event === "text" && "delta" in frame);
  }
}

async function startDriver(autoStop = true) {
  vi.stubEnv("VOICE_DRIVER_AUTO_STOP", String(autoStop));
  // The executable driver is JavaScript; import it only after mocking its IO.
  const path = "../live/voice-driver.mjs";
  await import(path);
  if (!tunnel.handler) throw new Error("driver did not register a socket handler");
  const socket = new Socket();
  const running = tunnel.handler(socket);
  socket.push({ event: "start" });
  await vi.advanceTimersByTimeAsync(0);
  return { socket, running };
}

async function heard(socket: Socket, final = false) {
  socket.push({ event: "transcript", text: "Still speaking", is_final: final });
  await vi.advanceTimersByTimeAsync(0);
}

async function stop(socket: Socket, running: Promise<void>) {
  socket.push({ event: "stop" });
  await running;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubEnv("REMOTE_INKBOX_API_KEY", "synthetic-driver-key");
  vi.stubEnv("VOICE_DRIVER_LINE", "Scripted request");
  vi.stubEnv("VOICE_DRIVER_GREETING", "Hello?");
  vi.stubEnv("VOICE_DRIVER_SPEAK_AFTER", "5");
  vi.stubEnv("VOICE_DRIVER_QUIET_GAP", "6");
  vi.stubEnv("VOICE_DRIVER_LISTEN", "12");
  vi.spyOn(process, "on").mockReturnValue(process);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("live driver greeting turn-taking", () => {
  it("waits for quiet across partial and final greeting transcripts", async () => {
    const { socket, running } = await startDriver();
    for (const final of [false, true, false]) {
      await vi.advanceTimersByTimeAsync(4_000);
      await heard(socket, final);
    }
    await vi.advanceTimersByTimeAsync(5_999);
    expect(socket.spoken().map((frame) => frame.delta)).toEqual(["Hello?"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.spoken().map((frame) => frame.delta)).toEqual(["Hello?", "Scripted request"]);
    await stop(socket, running);
  });

  it("asks a silent peer after the configured initial delay", async () => {
    const { socket, running } = await startDriver();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(socket.spoken()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.spoken().map((frame) => frame.delta)).toEqual(["Hello?", "Scripted request"]);
    await stop(socket, running);
  });

  it.each([true, false])(
    "bounds a continuous greeting and preserves auto-stop=%s",
    async (autoStop) => {
      const { socket, running } = await startDriver(autoStop);
      for (let count = 0; count < 7; count++) {
        await vi.advanceTimersByTimeAsync(4_000);
        await heard(socket);
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(socket.spoken().map((frame) => frame.delta)).toEqual(["Hello?"]);
      expect(socket.frames.filter((frame) => frame.event === "stop")).toHaveLength(
        autoStop ? 1 : 0,
      );
      await stop(socket, running);
    },
  );
});
