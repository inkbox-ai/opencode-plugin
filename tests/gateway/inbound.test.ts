import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AGENT_BODY_MAX_BYTES,
  createInboundHandler,
  RETRY_DELAYS_MS,
  SCRIPT_TIMEOUT_MS,
} from "../../src/gateway/inbound.js";
import type { VerifiedEvent } from "../../src/gateway/types.js";

const dirs: string[] = [];
const handlers: ReturnType<typeof createInboundHandler>[] = [];
afterEach(() => {
  for (const handler of handlers.splice(0)) handler.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(client: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-"));
  dirs.push(dir);
  const sessions = { runCapture: vi.fn(async (_key: string, _text: string) => undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () => {
    const handler = createInboundHandler({
      dir: path.join(dir, "events"),
      inkbox: {
        getClient: async () => client,
        getIdentity: async () => ({ agentHandle: "agent" }),
      } as never,
      sessions,
      logger,
      cwd: dir,
    });
    handlers.push(handler);
    return handler;
  };
  return { dir, sessions, logger, handler: make(), make };
}

function inboundEvent(
  handler: Record<string, unknown>,
  over: Record<string, unknown> = {},
  verified = true,
  ids: Record<string, unknown> = { delivery_id: "inbdlv_1" },
): VerifiedEvent {
  return {
    provider: "inkbox",
    verified,
    eventType: "inbound.received",
    body: {
      event_type: "inbound.received",
      data: {
        event_id: "inbev_1",
        ...ids,
        source: { id: "inbsrc_1", name: "payments", instructions: "Log each payment." },
        handler,
        signature_verified: true,
        request: {
          method: "POST",
          query: {},
          headers: { "content-type": "application/json" },
          content_type: "application/json",
          body: '{"amount":5}',
          body_encoding: "utf8",
          ...over,
        },
      },
    },
    headers: {},
  };
}

it("runs one agent turn per event with the untrusted header, instructions and body", async () => {
  const { handler } = setup();
  const run = vi.fn(async (_key: string, _text: string) => undefined);
  expect(await handler.handle(inboundEvent({ type: "agent" }), run)).toBe(true);
  expect(await handler.handle(inboundEvent({ type: "agent" }), run)).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  const [key, text] = run.mock.calls[0]!;
  expect(key).toBe("inbound:payments");
  expect(text).toMatch(/^UNTRUSTED EXTERNAL CONTENT from inbound source "payments"/);
  expect(text.indexOf("Log each payment.")).toBeLessThan(text.indexOf('{"amount":5}'));
});

it("runs a replay again but not a retry of the same delivery", async () => {
  const { handler } = setup();
  const run = vi.fn(async (_key: string, _text: string) => undefined);
  await handler.handle(inboundEvent({ type: "agent" }), run);
  await handler.handle(inboundEvent({ type: "agent" }), run);
  await handler.handle(inboundEvent({ type: "agent" }, {}, true, { delivery_id: "inbdlv_2" }), run);
  expect(run).toHaveBeenCalledTimes(2);
});

it("dedupes on the event id when there is no delivery id", async () => {
  const { dir, handler } = setup();
  const run = vi.fn(async (_key: string, _text: string) => undefined);
  await handler.handle(inboundEvent({ type: "agent" }, {}, true, {}), run);
  await handler.handle(inboundEvent({ type: "agent" }, {}, true, {}), run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(dir, "events/inbev_1.json"))).toBe(true);
});

it("caps the agent body at 64 KiB on a character boundary", async () => {
  const { handler } = setup();
  const run = vi.fn(async (_key: string, _text: string) => undefined);
  const body = `${"a".repeat(AGENT_BODY_MAX_BYTES - 1)}é tail`;
  await handler.handle(inboundEvent({ type: "agent" }, { body }), run);
  const text = run.mock.calls[0]![1];
  expect(text.endsWith(`${"a".repeat(AGENT_BODY_MAX_BYTES - 1)}\n(truncated)`)).toBe(true);
  expect(text).not.toContain("\uFFFD");
});

it("caps script output in the agent turn but passes the full body on stdin", async () => {
  const { dir, handler, sessions } = setup();
  const out = path.join(dir, "stdin.json");
  const body = "b".repeat(AGENT_BODY_MAX_BYTES + 10);
  await handler.handle(
    inboundEvent(
      { type: "script", command: `tee ${out} | head -c ${AGENT_BODY_MAX_BYTES + 10}` },
      { body },
    ),
    vi.fn(),
  );
  await vi.waitFor(() => expect(sessions.runCapture).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fs.readFileSync(out, "utf-8")).body).toBe(body);
  expect(sessions.runCapture.mock.calls[0]![1].endsWith("\n(truncated)")).toBe(true);
});

it("describes a binary body instead of including it", async () => {
  const { handler } = setup();
  const run = vi.fn(async (_key: string, _text: string) => undefined);
  await handler.handle(
    inboundEvent(
      { type: "agent" },
      { body: Buffer.from("abc").toString("base64"), body_encoding: "base64" },
    ),
    run,
  );
  expect(run.mock.calls[0]![1]).toContain("[Binary body, 3 bytes (application/json); not shown.]");
});

it("ignores unverified events", async () => {
  const { handler } = setup();
  const run = vi.fn(async () => undefined);
  expect(await handler.handle(inboundEvent({ type: "agent" }, {}, false), run)).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

it("acks a script event before running it and passes the event on stdin", async () => {
  const { dir, handler, sessions } = setup();
  const out = path.join(dir, "stdin.json");
  const run = vi.fn(async () => undefined);
  expect(await handler.handle(inboundEvent({ type: "script", command: `cat > ${out}` }), run)).toBe(
    true,
  );
  await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "events/inbdlv_1.json"))).toBe(true));
  await vi.waitFor(() =>
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "events/inbdlv_1.json"), "utf-8")).status,
    ).toBe("done"),
  );
  expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({
    source: "payments",
    event_id: "inbev_1",
    headers: { "content-type": "application/json" },
    body: '{"amount":5}',
    body_encoding: "utf8",
  });
  expect(run).not.toHaveBeenCalled();
  expect(sessions.runCapture).not.toHaveBeenCalled();
});

it("turns script stdout into an agent turn", async () => {
  const { handler, sessions } = setup();
  await handler.handle(
    inboundEvent({ type: "script", command: "echo 'refund requested'" }),
    vi.fn(),
  );
  await vi.waitFor(() => expect(sessions.runCapture).toHaveBeenCalledTimes(1));
  const [key, text] = sessions.runCapture.mock.calls[0]!;
  expect(key).toBe("inbound:payments");
  expect(text).toContain("refund requested");
});

it("runs a failing script 5 times on the backoff schedule, then reports the failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const report = vi.fn(async () => undefined);
  const { dir, handler } = setup({ inbound: { reportInboundEventResult: report } });
  const marker = path.join(dir, "runs");
  await handler.handle(
    inboundEvent({ type: "script", command: `echo x >> ${marker}; echo boom >&2; exit 3` }),
    vi.fn(),
  );
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").length / 2 : 0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(runs()).toBe(1));
  const job = () => JSON.parse(fs.readFileSync(path.join(dir, "events/inbdlv_1.json"), "utf-8"));
  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    await vi.waitFor(() => expect(job().attempts).toBe(index + 1));
    expect(job().nextAt - job().updatedAt).toBe(delay);
    expect(runs()).toBe(index + 1);
    await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(runs()).toBe(index + 2));
  }
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith("agent", "inbsrc_1", "inbev_1", {
      status: "failed",
      error: "boom",
    }),
  );
  expect(runs()).toBe(5);
  expect(RETRY_DELAYS_MS).toEqual([10_000, 30_000, 120_000, 600_000]);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(runs()).toBe(5);
  expect(report).toHaveBeenCalledTimes(1);
});

it("kills a script at the timeout and counts it as a failed attempt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dir, handler } = setup();
  await handler.handle(inboundEvent({ type: "script", command: "sleep 30" }), vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
  await vi.waitFor(() =>
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "events/inbdlv_1.json"), "utf-8")).attempts,
    ).toBe(1),
  );
});

it("resumes queued scripts after a restart and skips reporting on older SDKs", async () => {
  const { dir, make, logger } = setup();
  fs.writeFileSync(
    path.join(dir, "events/inbev_2.json"),
    JSON.stringify({
      status: "queued",
      eventId: "inbev_2",
      sourceId: "inbsrc_1",
      source: "payments",
      command: `echo ok > ${path.join(dir, "resumed")}`,
      input: "{}",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  make().recover();
  await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "resumed"))).toBe(true));
  expect(logger.error).not.toHaveBeenCalled();
});
