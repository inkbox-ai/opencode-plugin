import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  AGENT_BODY_MAX_BYTES,
  createInboundHandler,
  InboundEventInvalidError,
  InboundQueueFullError,
  MAX_CONCURRENT_SCRIPTS,
  MAX_PENDING_BYTES,
  MAX_PENDING_EVENTS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  RETRY_DELAYS_MS,
  SCRIPT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
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
  const sessions = {
    runInbound: vi.fn(
      async (
        _key: string,
        _text: string,
        _deliveryId: string,
        _timeoutMs?: number,
      ): Promise<string | undefined> => undefined,
    ),
  };
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

const DELIVERY = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const EVENT = "inbev_2b7e9c1a-4d3f-4a5b-9c8d-7e6f5a4b3c2d";
const SOURCE = "inbsrc_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// Mirrors the signed envelope the server delivers to a hosted agent.
function inboundEvent(
  handler: Record<string, unknown>,
  over: Record<string, unknown> = {},
  verified = true,
  deliveryId: string | null = DELIVERY,
): VerifiedEvent {
  const id = `evt_${"a".repeat(64)}`;
  return {
    provider: "inkbox",
    verified,
    eventType: "inbound.received",
    requestId: id,
    body: {
      event_type: "inbound.received",
      timestamp: "2026-11-19T12:00:00+00:00",
      data: {
        event_id: EVENT,
        ...(deliveryId === null ? {} : { delivery_id: deliveryId }),
        received_at: "2026-11-19T11:59:59+00:00",
        source: {
          id: SOURCE,
          name: "payments",
          instructions: "Log each payment.",
        },
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
      id,
      hosted_delivery: {
        version: 1,
        activation_id: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
        event_id: id,
        starts_agent: true,
      },
    },
    headers: {},
  } as VerifiedEvent;
}

const jobFile = (dir: string, id = DELIVERY) => path.join(dir, "events", `${id}.json`);
const job = (dir: string, id = DELIVERY) => JSON.parse(fs.readFileSync(jobFile(dir, id), "utf-8"));

function deferred() {
  let resolve!: (value: string | undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string | undefined>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const apiError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

it("persists an agent event, acks it, and finishes it only after the turn succeeds", async () => {
  const { dir, handler, sessions } = setup();
  const turn = deferred();
  sessions.runInbound.mockImplementationOnce(() => turn.promise);
  expect(await handler.handle(inboundEvent({ type: "agent" }))).toBe(true);
  expect(job(dir).status).toBe("agent");
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  const [key, text] = sessions.runInbound.mock.calls[0]!;
  expect(key).toBe(`inbound:${SOURCE}`);
  expect(text).toMatch(/^UNTRUSTED EXTERNAL CONTENT from inbound source "payments"/);
  expect(text.indexOf("Log each payment.")).toBeLessThan(text.indexOf('{"amount":5}'));
  expect(job(dir).status).toBe("agent");
  expect(handler.pending()).toBe(1);
  turn.resolve("ok");
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(handler.pending()).toBe(0);
  expect(job(dir).message).toBeUndefined();
});

it("dedupes on delivery_id: a retry is skipped, a replay runs again", async () => {
  const { handler, sessions } = setup();
  await handler.handle(inboundEvent({ type: "agent" }));
  await handler.handle(inboundEvent({ type: "agent" }));
  await handler.handle(
    inboundEvent({ type: "agent" }, {}, true, "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  );
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(2));
});

it("ignores unverified or non-Inkbox events and rejects malformed ones", async () => {
  const { dir, handler, sessions } = setup();
  expect(await handler.handle(inboundEvent({ type: "agent" }, {}, false))).toBe(true);
  expect(
    await handler.handle({
      ...inboundEvent({ type: "agent" }),
      provider: "external",
    } as VerifiedEvent),
  ).toBe(true);
  for (const malformed of [
    inboundEvent({ type: "agent" }, {}, true, null),
    inboundEvent({ type: "unknown" }),
    inboundEvent({ type: "script" }),
  ]) {
    await expect(handler.handle(malformed)).rejects.toBeInstanceOf(InboundEventInvalidError);
    expect(() => handler.admits(malformed)).toThrow(InboundEventInvalidError);
  }
  expect(fs.readdirSync(path.join(dir, "events"))).toEqual([]);
  expect(sessions.runInbound).not.toHaveBeenCalled();
});

it("caps the agent body at 64 KiB on a character boundary", async () => {
  const { handler, sessions } = setup();
  const body = `${"a".repeat(AGENT_BODY_MAX_BYTES - 1)}é tail`;
  await handler.handle(inboundEvent({ type: "agent" }, { body }));
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  const text = sessions.runInbound.mock.calls[0]![1];
  expect(text.endsWith(`${"a".repeat(AGENT_BODY_MAX_BYTES - 1)}\n(truncated)`)).toBe(true);
  expect(text).not.toContain("�");
});

it("describes a binary body instead of including it", async () => {
  const { handler, sessions } = setup();
  await handler.handle(
    inboundEvent(
      { type: "agent" },
      { body: Buffer.from([0xff, 0xfe, 0]).toString("base64"), body_encoding: "base64" },
    ),
  );
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  expect(sessions.runInbound.mock.calls[0]![1]).toContain(
    "[Binary body, 3 bytes (application/json); not shown.]",
  );
});

it("reports a failed agent turn with the delivery id", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler, sessions } = setup({
    inbound: { reportInboundEventResult: report },
  });
  sessions.runInbound.mockRejectedValueOnce(new Error("model unavailable"));
  await handler.handle(inboundEvent({ type: "agent" }));
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith("agent", SOURCE, EVENT, {
      status: "failed",
      error: "Error: model unavailable",
      deliveryId: DELIVERY,
    }),
  );
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(sessions.runInbound).toHaveBeenCalledTimes(1);
});

it("gives the session queue the 30-minute turn limit and reports a turn it stops", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler, sessions } = setup({
    inbound: { reportInboundEventResult: report },
  });
  sessions.runInbound.mockRejectedValueOnce(
    new Error("agent turn did not finish within 30 minutes"),
  );
  await handler.handle(inboundEvent({ type: "agent" }));
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith("agent", SOURCE, EVENT, {
      status: "failed",
      error: "Error: agent turn did not finish within 30 minutes",
      deliveryId: DELIVERY,
    }),
  );
  expect(sessions.runInbound.mock.calls[0]![3]).toBe(TURN_TIMEOUT_MS);
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
});

it("keys the session on the source id, so sources sharing a name stay separate", async () => {
  const { handler, sessions } = setup();
  const other = "inbsrc_9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
  const event = inboundEvent({ type: "agent" });
  const renamed = inboundEvent({ type: "agent" }, {}, true, "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
  (renamed.body.data as { source: { id: string } }).source.id = other;
  await handler.handle(event);
  await handler.handle(renamed);
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(2));
  expect(sessions.runInbound.mock.calls.map((call) => call[0]).sort()).toEqual(
    [`inbound:${SOURCE}`, `inbound:${other}`].sort(),
  );
});

it("refuses a new delivery once the queue holds the maximum number of events", async () => {
  const { handler, sessions } = setup();
  sessions.runInbound.mockImplementation(() => new Promise(() => {}));
  const id = (n: number) => `delivery-${n}`;
  for (let n = 0; n < MAX_PENDING_EVENTS; n++)
    await handler.handle(inboundEvent({ type: "agent" }, {}, true, id(n)));
  expect(handler.pending()).toBe(MAX_PENDING_EVENTS);
  // A retry of a stored delivery is still acknowledged.
  expect(handler.admits(inboundEvent({ type: "agent" }, {}, true, id(0)))).toBe(true);
  await expect(handler.handle(inboundEvent({ type: "agent" }, {}, true, id(0)))).resolves.toBe(
    true,
  );
  const extra = inboundEvent({ type: "agent" }, {}, true, "delivery-extra");
  expect(handler.admits(extra)).toBe(false);
  await expect(handler.handle(extra)).rejects.toBeInstanceOf(InboundQueueFullError);
});

it("refuses a new delivery that would exceed the stored byte limit", async () => {
  const { handler, sessions } = setup();
  sessions.runInbound.mockImplementation(() => new Promise(() => {}));
  const large = "x".repeat(Math.floor(MAX_PENDING_BYTES / 2));
  await handler.handle(
    inboundEvent({ type: "script", command: "sleep 30" }, { body: large }, true, "big-1"),
  );
  await expect(
    handler.handle(
      inboundEvent({ type: "script", command: "sleep 30" }, { body: large }, true, "big-2"),
    ),
  ).rejects.toBeInstanceOf(InboundQueueFullError);
  await expect(handler.handle(inboundEvent({ type: "agent" }, {}, true, "small"))).resolves.toBe(
    true,
  );
});

it("runs at most four scripts at once", async () => {
  const { dir, handler } = setup();
  const log = path.join(dir, "log");
  const command = `echo start >> ${log}; sleep 0.3; echo end >> ${log}`;
  for (let n = 0; n < MAX_CONCURRENT_SCRIPTS + 2; n++)
    await handler.handle(inboundEvent({ type: "script", command }, {}, true, `script-${n}`));
  await vi.waitFor(
    () => {
      const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n") : [];
      expect(lines.filter((line) => line === "end")).toHaveLength(MAX_CONCURRENT_SCRIPTS + 2);
    },
    { timeout: 5000 },
  );
  let running = 0;
  let peak = 0;
  for (const line of fs.readFileSync(log, "utf-8").trim().split("\n")) {
    running += line === "start" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  expect(peak).toBe(MAX_CONCURRENT_SCRIPTS);
  await vi.waitFor(() => expect(handler.pending()).toBe(0));
});

it("keeps a record it cannot read at startup and retries it later", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { dir, make, sessions } = setup();
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  // A directory in place of the record makes the read fail with an I/O error.
  fs.mkdirSync(jobFile(dir));
  const handler = make();
  handler.recover();
  expect(fs.existsSync(jobFile(dir))).toBe(true);
  expect(handler.pending()).toBe(1);
  fs.rmdirSync(jobFile(dir));
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "agent",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      message: "turn",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  while (job(dir).status !== "done") await new Promise((r) => setImmediate(r));
  expect(sessions.runInbound).toHaveBeenCalledTimes(1);
  expect(handler.pending()).toBe(0);
});

it("discards a record that is not valid JSON", async () => {
  const { dir, make } = setup();
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  fs.writeFileSync(jobFile(dir), "{not json");
  const handler = make();
  handler.recover();
  expect(fs.existsSync(jobFile(dir))).toBe(false);
  expect(handler.pending()).toBe(0);
});

it("does not treat an unreadable existing record as a new delivery", async () => {
  const { dir, handler, sessions } = setup();
  fs.mkdirSync(jobFile(dir));
  await expect(handler.handle(inboundEvent({ type: "agent" }))).rejects.toThrow();
  expect(fs.statSync(jobFile(dir)).isDirectory()).toBe(true);
  expect(sessions.runInbound).not.toHaveBeenCalled();
});

it("acks a script event before running it and passes the event on stdin", async () => {
  const { dir, handler, sessions } = setup();
  const out = path.join(dir, "stdin.json");
  expect(await handler.handle(inboundEvent({ type: "script", command: `cat > ${out}` }))).toBe(
    true,
  );
  expect(job(dir).status).toBe("queued");
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({
    source: "payments",
    event_id: EVENT,
    headers: { "content-type": "application/json" },
    body: '{"amount":5}',
    body_encoding: "utf8",
  });
  expect(sessions.runInbound).not.toHaveBeenCalled();
});

it("turns script stdout into an agent turn and finishes after it", async () => {
  const { dir, handler, sessions } = setup();
  await handler.handle(inboundEvent({ type: "script", command: "echo 'refund requested'" }));
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  const [key, text] = sessions.runInbound.mock.calls[0]!;
  expect(key).toBe(`inbound:${SOURCE}`);
  expect(text).toContain("refund requested");
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
});

it("drains large output, keeps 64 KiB of stdout, and passes the full body on stdin", async () => {
  const { dir, handler, sessions } = setup();
  const out = path.join(dir, "stdin.json");
  const body = "b".repeat(AGENT_BODY_MAX_BYTES + 10);
  await handler.handle(
    inboundEvent(
      {
        type: "script",
        command: `cat > ${out}; head -c 4000000 /dev/zero | tr '\\0' x`,
      },
      { body },
    ),
  );
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1), {
    timeout: 10_000,
  });
  expect(JSON.parse(fs.readFileSync(out, "utf-8")).body).toBe(body);
  const text = sessions.runInbound.mock.calls[0]![1];
  expect(text).toContain(`${"x".repeat(MAX_STDOUT_BYTES)}\n(truncated)`);
  expect(text).not.toContain("x".repeat(MAX_STDOUT_BYTES + 1));
});

it("runs a failing script 5 times on the backoff schedule, counts it as pending, then reports a 4 KiB stderr tail", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const report = vi.fn(async () => undefined);
  const { dir, handler } = setup({
    inbound: { reportInboundEventResult: report },
  });
  const marker = path.join(dir, "runs");
  await handler.handle(
    inboundEvent({
      type: "script",
      command: `echo x >> ${marker}; head -c 10000 /dev/zero | tr '\\0' e >&2; echo boom >&2; exit 3`,
    }),
  );
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").length / 2 : 0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(runs()).toBe(1));
  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    await vi.waitFor(() => expect(job(dir).nextAt - job(dir).updatedAt).toBe(delay));
    expect(job(dir).attempts).toBe(index + 1);
    expect(handler.pending()).toBe(1);
    expect(runs()).toBe(index + 1);
    await vi.advanceTimersByTimeAsync(delay);
    await vi.waitFor(() => expect(runs()).toBe(index + 2));
  }
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  const [handle, sourceId, eventId, result] = report.mock.calls[0]! as unknown as [
    string,
    string,
    string,
    { status: string; error: string; deliveryId: string },
  ];
  expect([handle, sourceId, eventId, result.status, result.deliveryId]).toEqual([
    "agent",
    SOURCE,
    EVENT,
    "failed",
    DELIVERY,
  ]);
  expect(result.error.endsWith("eeeboom")).toBe(true);
  expect(Buffer.byteLength(result.error)).toBeLessThanOrEqual(MAX_STDERR_BYTES);
  expect(runs()).toBe(5);
  expect(RETRY_DELAYS_MS).toEqual([10_000, 30_000, 120_000, 600_000]);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(runs()).toBe(5);
  expect(report).toHaveBeenCalledTimes(1);
  expect(handler.pending()).toBe(0);
});

it("retries a failed report with backoff without re-running the script, and treats 409 as done", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const report = vi
    .fn()
    .mockRejectedValueOnce(apiError(503))
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockRejectedValueOnce(apiError(409));
  const { dir, make } = setup({
    inbound: { reportInboundEventResult: report },
  });
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "report",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      command: `echo x >> ${path.join(dir, "runs")}`,
      error: "boom",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  const handler = make();
  handler.recover();
  // A pending failure report does not keep the agent awake.
  expect(handler.pending()).toBe(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(job(dir).attempts).toBe(1));
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(job(dir).attempts).toBe(2));
  expect(handler.pending()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(report).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(path.join(dir, "runs"))).toBe(false);
  expect(handler.pending()).toBe(0);
});

it("keeps retrying a report past 24 hours until it is accepted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const report = vi.fn(async () => {
    throw apiError(503);
  });
  const { dir, make, logger } = setup({
    inbound: { reportInboundEventResult: report },
  });
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "report",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      error: "boom",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  make().recover();
  await vi.advanceTimersByTimeAsync(30 * 3_600_000);
  expect(job(dir).status).toBe("report");
  expect(report.mock.calls.length).toBeGreaterThan(20);
  report.mockResolvedValue(undefined as never);
  await vi.advanceTimersByTimeAsync(3_600_000);
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(logger.error).not.toHaveBeenCalled();
});

it("kills a script at the timeout and counts it as a failed attempt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dir, handler } = setup();
  await handler.handle(inboundEvent({ type: "script", command: "sleep 30" }));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
  await vi.waitFor(() => expect(job(dir).attempts).toBe(1));
});

it("resumes queued scripts and agent turns after a restart", async () => {
  const { dir, make, sessions, logger } = setup();
  const base = {
    eventId: EVENT,
    sourceId: SOURCE,
    source: "payments",
    attempts: 0,
    nextAt: 0,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(
    jobFile(dir, "script-1"),
    JSON.stringify({
      ...base,
      status: "queued",
      deliveryId: "script-1",
      command: `echo ok > ${path.join(dir, "resumed")}`,
      input: "{}",
    }),
  );
  fs.writeFileSync(
    jobFile(dir, "agent-1"),
    JSON.stringify({
      ...base,
      status: "agent",
      deliveryId: "agent-1",
      message: "resumed turn",
    }),
  );
  const handler = make();
  handler.recover();
  expect(handler.pending()).toBe(2);
  await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "resumed"))).toBe(true));
  await vi.waitFor(() =>
    expect(sessions.runInbound).toHaveBeenCalledWith(
      `inbound:${SOURCE}`,
      "resumed turn",
      "agent-1",
      TURN_TIMEOUT_MS,
    ),
  );
  await vi.waitFor(() => expect(handler.pending()).toBe(0));
  expect(logger.error).not.toHaveBeenCalled();
});

it("rejoins the session turn for a started agent job after a restart", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler, sessions, make } = setup({
    inbound: { reportInboundEventResult: report },
  });
  const turn = deferred();
  sessions.runInbound.mockImplementationOnce(() => turn.promise);
  await handler.handle(inboundEvent({ type: "agent" }));
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  handler.close();
  turn.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(job(dir)).toMatchObject({ status: "agent", started: true });
  make().recover();
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  // The same delivery id lets the session queue return its recorded turn instead of a new one.
  expect(sessions.runInbound).toHaveBeenCalledTimes(2);
  expect(sessions.runInbound.mock.calls[1]![2]).toBe(DELIVERY);
  expect(report).not.toHaveBeenCalled();
});

it("reports a started turn the session queue recorded as failed", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, sessions, make } = setup({
    inbound: { reportInboundEventResult: report },
  });
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "agent",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      message: "turn",
      started: true,
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  sessions.runInbound.mockRejectedValueOnce(new Error("Agent turn was interrupted."));
  make().recover();
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(report).toHaveBeenCalledWith("agent", SOURCE, EVENT, {
    status: "failed",
    error: "Error: Agent turn was interrupted.",
    deliveryId: DELIVERY,
  });
});

it("counts a script run before it starts and never runs a sixth time after a restart", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler, make } = setup({
    inbound: { reportInboundEventResult: report },
  });
  const seen = path.join(dir, "seen");
  await handler.handle(
    inboundEvent({ type: "script", command: `cat ${jobFile(dir)} > ${seen}; exit 1` }),
  );
  await vi.waitFor(() => expect(fs.existsSync(seen)).toBe(true));
  expect(JSON.parse(fs.readFileSync(seen, "utf-8")).attempts).toBe(1);
  handler.close();
  const marker = path.join(dir, "runs");
  // Five runs have started; the fifth was cut off by a restart.
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      ...job(dir),
      status: "queued",
      attempts: 5,
      nextAt: 0,
      command: `echo x >> ${marker}`,
    }),
  );
  make().recover();
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(fs.existsSync(marker)).toBe(false);
  expect(report).toHaveBeenCalledWith("agent", SOURCE, EVENT, {
    status: "failed",
    error: "Script run was interrupted by a restart.",
    deliveryId: DELIVERY,
  });
});

it("sends at most 2000 characters of error text", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler } = setup({
    inbound: { reportInboundEventResult: report },
  });
  await handler.handle(
    inboundEvent({
      type: "script",
      command: "head -c 3000 /dev/zero | tr '\\0' e >&2; echo END >&2; exit 1",
    }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  for (const delay of RETRY_DELAYS_MS) {
    await vi.waitFor(() => expect(job(dir).nextAt).toBeGreaterThan(Date.now()));
    await vi.advanceTimersByTimeAsync(delay);
  }
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  const result = (
    report.mock.calls[0] as unknown as [string, string, string, { error: string }]
  )[3];
  expect(result.error).toHaveLength(2000);
  expect(result.error.endsWith("END")).toBe(true);
  expect(job(dir).error.length).toBeGreaterThan(2000);
});

it("shows a base64 body that decodes to UTF-8 as text", async () => {
  const { handler, sessions } = setup();
  await handler.handle(
    inboundEvent(
      { type: "agent" },
      { body: Buffer.from('{"note":"café"}').toString("base64"), body_encoding: "base64" },
    ),
  );
  await vi.waitFor(() => expect(sessions.runInbound).toHaveBeenCalledTimes(1));
  expect(sessions.runInbound.mock.calls[0]![1]).toContain('{"note":"café"}');
  expect(sessions.runInbound.mock.calls[0]![1]).not.toContain("Binary body");
});

it("reports a failed turn on script output without re-running the script", async () => {
  const report = vi.fn(async () => undefined);
  const { dir, handler, sessions } = setup({
    inbound: { reportInboundEventResult: report },
  });
  sessions.runInbound.mockRejectedValueOnce(new Error("model unavailable"));
  const marker = path.join(dir, "runs");
  await handler.handle(
    inboundEvent({ type: "script", command: `echo x >> ${marker}; echo summary` }),
  );
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(job(dir).status).toBe("done"));
  expect(fs.readFileSync(marker, "utf-8")).toBe("x\n");
  expect(sessions.runInbound).toHaveBeenCalledTimes(1);
});

it.each([
  [400, false],
  [404, false],
  [422, false],
  [408, true],
  [429, true],
  [500, true],
])("ends report retries on HTTP %s unless retryable (%s)", async (status, retried) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const report = vi.fn(async () => {
    throw apiError(status);
  });
  const { dir, make } = setup({
    inbound: { reportInboundEventResult: report },
  });
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "report",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      error: "boom",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  make().recover();
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(job(dir).status === "done" || job(dir).attempts === 1).toBe(true));
  expect(job(dir).status).toBe(retried ? "report" : "done");
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(retried ? 2 : 1));
});

it("finishes an unrunnable record instead of keeping it pending", async () => {
  const { dir, make } = setup();
  fs.writeFileSync(
    jobFile(dir),
    JSON.stringify({
      status: "agent",
      deliveryId: DELIVERY,
      eventId: EVENT,
      sourceId: SOURCE,
      source: "payments",
      attempts: 0,
      nextAt: 0,
      updatedAt: Date.now(),
    }),
  );
  const handler = make();
  handler.recover();
  await vi.waitFor(() => expect(handler.pending()).toBe(0));
  expect(job(dir).status).toBe("done");
});
