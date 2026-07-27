// Slash commands: non-command passthrough plus /clear, /stop, /status,
// /health, /usage, /resume, and the unknown-command fallback.
import { describe, expect, it, vi } from "vitest";
import type { CommandDeps } from "../../src/gateway/commands.js";
import { handleCommand } from "../../src/gateway/commands.js";

function makeSessions(over: Record<string, unknown> = {}) {
  return {
    handleInbound: vi.fn(async () => {}),
    runCapture: vi.fn(async () => undefined),
    runText: vi.fn(async () => undefined),
    runA2A: vi.fn(async () => undefined),
    abortA2A: vi.fn(async () => false),
    resetSession: vi.fn(async () => {}),
    abortTurn: vi.fn(async () => true),
    status: vi.fn(() => ({ busy: false, sessionID: undefined as string | undefined })),
    close: vi.fn(async () => {}),
    ...over,
  };
}

function makeDeps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    opencode: { session: { list: vi.fn(), messages: vi.fn() } } as never,
    inkbox: {} as never,
    sessions: makeSessions() as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    directory: "/proj",
    health: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

describe("handleCommand routing", () => {
  it("returns null for a message that is not a slash command", async () => {
    const deps = makeDeps();
    expect(await handleCommand(deps, "ck", "hello there")).toBeNull();
    expect(deps.sessions.resetSession as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("resets the session on /clear and confirms a fresh start", async () => {
    const deps = makeDeps();
    const out = await handleCommand(deps, "ck", "/clear");
    expect(deps.sessions.resetSession).toHaveBeenCalledWith("ck");
    expect(out).toBe("Started a fresh conversation. What's next?");
  });

  it("reports an unknown command with the offending word", async () => {
    const out = await handleCommand(makeDeps(), "ck", "/frobnicate now");
    expect(out).toContain("/frobnicate");
  });
});

describe("/stop", () => {
  it("confirms a stop when a turn was aborted", async () => {
    const deps = makeDeps({
      sessions: makeSessions({ abortTurn: vi.fn(async () => true) }) as never,
    });
    expect(await handleCommand(deps, "ck", "/stop")).toBe("Stopped.");
  });

  it("says nothing was running when there was no turn to abort", async () => {
    const deps = makeDeps({
      sessions: makeSessions({ abortTurn: vi.fn(async () => false) }) as never,
    });
    expect(await handleCommand(deps, "ck", "/stop")).toBe("Nothing was running.");
  });
});

describe("/status", () => {
  it("reflects a busy session", async () => {
    const deps = makeDeps({
      sessions: makeSessions({ status: vi.fn(() => ({ busy: true })) }) as never,
    });
    expect(await handleCommand(deps, "ck", "/status")).toBe("Working on your last message.");
  });

  it("reflects an idle session", async () => {
    const deps = makeDeps({
      sessions: makeSessions({ status: vi.fn(() => ({ busy: false })) }) as never,
    });
    expect(await handleCommand(deps, "ck", "/status")).toBe("Idle — send me something.");
  });
});

describe("/health", () => {
  it("formats a healthy probe with its per-check lines", async () => {
    const deps = makeDeps({ health: vi.fn(async () => ({ ok: true, tunnel: "up" })) });
    const out = await handleCommand(deps, "ck", "/health");
    expect(out).toContain("Healthy.");
    expect(out).toContain("tunnel: up");
  });

  it("flags problems when the probe is not ok", async () => {
    const deps = makeDeps({ health: vi.fn(async () => ({ ok: false, server: "unreachable" })) });
    const out = await handleCommand(deps, "ck", "/health");
    expect(out).toContain("Problems detected.");
    expect(out).toContain("server: unreachable");
  });
});

describe("/usage", () => {
  it("sums input and output tokens across the session's messages", async () => {
    const messages = vi.fn(async () => ({
      data: [
        { info: { tokens: { input: 10, output: 5 } } },
        { info: { tokens: { input: 3, output: 2 } } },
      ],
    }));
    const deps = makeDeps({
      opencode: { session: { list: vi.fn(), messages } } as never,
      sessions: makeSessions({
        status: vi.fn(() => ({ busy: false, sessionID: "sess-1" })),
      }) as never,
    });

    const out = await handleCommand(deps, "ck", "/usage");
    expect(messages).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      query: { directory: "/proj" },
    });
    expect(out).toBe("This conversation: 13 in / 7 out tokens.");
  });

  it("says there is no usage yet when the chatKey has no session", async () => {
    const deps = makeDeps({
      sessions: makeSessions({
        status: vi.fn(() => ({ busy: false, sessionID: undefined })),
      }) as never,
    });
    const out = await handleCommand(deps, "ck", "/usage");
    expect(out).toContain("No usage yet");
  });
});

describe("/resume", () => {
  it("lists recent sessions numbered by title, falling back to the id", async () => {
    const list = vi.fn(async () => ({
      data: [{ id: "s1", title: "Trip planning" }, { id: "s2" }],
    }));
    const deps = makeDeps({ opencode: { session: { list, messages: vi.fn() } } as never });

    const out = await handleCommand(deps, "ck", "/resume");
    expect(list).toHaveBeenCalledWith({ query: { directory: "/proj" } });
    // /resume returns a structured result carrying the ordered session ids the
    // next numeric reply selects from.
    const result = out as { reply: string; resume?: string[] };
    expect(result.reply).toContain("1. Trip planning");
    expect(result.reply).toContain("2. s2");
    expect(result.resume).toEqual(["s1", "s2"]);
  });
});
