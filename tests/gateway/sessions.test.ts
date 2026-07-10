// Session manager: per-chatKey session creation/reuse, prompt shaping,
// reply delivery, capture turns, abort, status, and turn serialization.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { defaultGatewayConfig } from "../../src/config.js";
import { createSessionManager, extractText } from "../../src/gateway/sessions.js";
import { createStateStore } from "../../src/gateway/state.js";
import type { InboundMessage } from "../../src/gateway/types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeIdentity() {
  return {
    sendEmail: vi.fn(async (_o: Record<string, unknown>) => ({ id: "email-1" })),
    sendText: vi.fn(async (_o: Record<string, unknown>) => ({ id: "sms-1" })),
    sendIMessage: vi.fn(async (_o: Record<string, unknown>) => ({ id: "im-1" })),
  };
}

interface PromptArg {
  path: { id: string };
  query: { directory: string };
  body: { parts: Array<{ type: string; text: string }> };
}

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sessions-"));
  tmpDirs.push(dir);
  const state = createStateStore(dir);
  const identity = makeIdentity();
  const inkbox = { getIdentity: vi.fn(async () => identity), getClient: vi.fn() };
  let created = 0;
  const opencode = {
    session: {
      create: vi.fn(async (_o: { body: { title: string }; query: { directory: string } }) => ({
        data: { id: `sess-${++created}` },
      })),
      prompt: vi.fn(
        async (_a: PromptArg): Promise<unknown> => ({
          data: { parts: [{ type: "text", text: "reply" }] },
        }),
      ),
      abort: vi.fn(async (_o: { path: { id: string }; query: { directory: string } }) => ({})),
      list: vi.fn(),
      messages: vi.fn(),
    },
  };
  const config = { gateway: { ...defaultGatewayConfig() } } as unknown as ResolvedConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mgr = createSessionManager({
    opencode: opencode as never,
    inkbox: inkbox as never,
    config,
    state,
    logger,
    directory: "/proj",
  });
  return { mgr, opencode, identity, state, inkbox };
}

function sms(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "sms",
    chatKey: "ck",
    from: "+15551112222",
    conversationId: "conv-1",
    text,
    mediaPaths: [],
    ...over,
  };
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("handleInbound", () => {
  it("creates a session on the first message and reuses it afterward", async () => {
    const { mgr, opencode, state } = makeManager();

    await mgr.handleInbound(sms("first"));
    expect(opencode.session.create).toHaveBeenCalledTimes(1);
    expect(opencode.session.create).toHaveBeenCalledWith({
      body: { title: "inkbox:ck" },
      query: { directory: "/proj" },
    });
    expect(state.getSession("ck")).toBe("sess-1");

    await mgr.handleInbound(sms("second"));
    expect(opencode.session.create).toHaveBeenCalledTimes(1);
    expect(opencode.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("prompts against the stored session id, directory, and a text part", async () => {
    const { mgr, opencode } = makeManager();
    await mgr.handleInbound(sms("hi there"));

    const call = opencode.session.prompt.mock.calls[0][0];
    expect(call.path).toEqual({ id: "sess-1" });
    expect(call.query).toEqual({ directory: "/proj" });
    expect(call.body.parts).toHaveLength(1);
    expect(call.body.parts[0].type).toBe("text");
    expect(call.body.parts[0].text).toContain("hi there");
  });

  it("delivers the assistant reply on the inbound channel", async () => {
    const { mgr, identity, opencode } = makeManager();
    opencode.session.prompt.mockResolvedValue({ data: { parts: [{ type: "text", text: "hi" }] } });

    await mgr.handleInbound(sms("ping"));

    expect(identity.sendText).toHaveBeenCalledTimes(1);
    expect(identity.sendText.mock.calls[0][0].text).toBe("hi");
  });
});

describe("runCapture", () => {
  it("runs a prompt, resolves with the text, and delivers nothing", async () => {
    const { mgr, identity, opencode } = makeManager();
    opencode.session.prompt.mockResolvedValue({
      data: { parts: [{ type: "text", text: "captured" }] },
    });

    await expect(mgr.runCapture("ck", "a webhook fired")).resolves.toBe("captured");

    expect(opencode.session.prompt).toHaveBeenCalledTimes(1);
    expect(identity.sendText).not.toHaveBeenCalled();
    expect(identity.sendEmail).not.toHaveBeenCalled();
    expect(identity.sendIMessage).not.toHaveBeenCalled();
  });
});

describe("abortTurn", () => {
  it("aborts the in-flight session and clears the queue when busy", async () => {
    const { mgr, opencode, state } = makeManager();
    state.setSession("ck", "sess-pre");
    let release: (v: unknown) => void = () => {};
    opencode.session.prompt.mockImplementation(
      () => new Promise<unknown>((resolve) => (release = resolve)),
    );

    const inflight = mgr.handleInbound(sms("long task"));
    await tick();

    await expect(mgr.abortTurn("ck")).resolves.toBe(true);
    expect(opencode.session.abort).toHaveBeenCalledWith({
      path: { id: "sess-pre" },
      query: { directory: "/proj" },
    });

    release({ data: { parts: [] } });
    await inflight;
  });

  it("returns false when nothing is running", async () => {
    const { mgr, state } = makeManager();
    state.setSession("ck", "sess-x");
    await expect(mgr.abortTurn("ck")).resolves.toBe(false);
  });
});

describe("status", () => {
  it("reflects the stored session id and idle state", async () => {
    const { mgr, state } = makeManager();
    state.setSession("ck", "sess-x");
    expect(mgr.status("ck")).toEqual({ busy: false, sessionID: "sess-x" });
    expect(mgr.status("unknown")).toEqual({ busy: false, sessionID: undefined });
  });
});

describe("turn serialization", () => {
  it("serializes two messages for one chatKey onto a single session", async () => {
    const { mgr, opencode } = makeManager();
    await Promise.all([mgr.handleInbound(sms("one")), mgr.handleInbound(sms("two"))]);

    expect(opencode.session.create).toHaveBeenCalledTimes(1);
    expect(opencode.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("runs a second chatKey on its own session", async () => {
    const { mgr, opencode } = makeManager();
    await mgr.handleInbound(sms("a", { chatKey: "ck-a", from: "+15550000001" }));
    await mgr.handleInbound(sms("b", { chatKey: "ck-b", from: "+15550000002" }));

    expect(opencode.session.create).toHaveBeenCalledTimes(2);
    const ids = opencode.session.prompt.mock.calls.map((c) => c[0].path.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("extractText", () => {
  it("concatenates text parts and ignores non-text parts", () => {
    const res = {
      data: {
        parts: [
          { type: "text", text: "Hello " },
          { type: "tool", text: "ignored" },
          { type: "text", text: "world" },
        ],
      },
    };
    expect(extractText(res)).toBe("Hello world");
  });

  it("reads a response that is not wrapped in data", () => {
    expect(extractText({ parts: [{ type: "text", text: "bare" }] })).toBe("bare");
  });

  it("returns undefined for empty, whitespace-only, or missing parts", () => {
    expect(extractText({ data: { parts: [] } })).toBeUndefined();
    expect(extractText({ data: { parts: [{ type: "text", text: "   " }] } })).toBeUndefined();
    expect(extractText({ data: {} })).toBeUndefined();
    expect(extractText(undefined)).toBeUndefined();
  });
});

describe("interrupt and abort", () => {
  it("does not abort an in-flight capture turn when a new message arrives", async () => {
    const { mgr, opencode } = makeManager();
    let release: (() => void) | undefined;
    opencode.session.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { parts: [{ type: "text", text: "capture" }] } });
        }),
    );
    const capture = mgr.runText("ck", "[inkbox:voice from=x]\nhi");
    await vi.waitFor(() => expect(opencode.session.prompt).toHaveBeenCalledTimes(1));
    // A normal inbound arrives while the capture is running.
    const inbound = mgr.handleInbound(sms("interrupt me"));
    release?.();
    await capture;
    await inbound;
    // The capture must never have been aborted.
    expect(opencode.session.abort).not.toHaveBeenCalled();
  });

  it("settles dropped queued turns when abortTurn clears the queue", async () => {
    const { mgr, opencode } = makeManager();
    let release: (() => void) | undefined;
    opencode.session.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { parts: [{ type: "text", text: "a" }] } });
        }),
    );
    const first = mgr.handleInbound(sms("first"));
    await vi.waitFor(() => expect(opencode.session.prompt).toHaveBeenCalledTimes(1));
    // Queue a second message behind the running turn, then abort.
    const second = mgr.handleInbound(sms("second"));
    const aborted = await mgr.abortTurn("ck");
    expect(aborted).toBe(true);
    release?.();
    // The dropped queued turn must settle (not hang) after the abort.
    await expect(second).resolves.toBeUndefined();
    await first;
  });
});
