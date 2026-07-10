// Webhook server: health, provider matching + signature gating, request-id
// dedup, and rollback on a failed dispatch — exercised over a real socket.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config.js";
import { defaultGatewayConfig } from "../../src/config.js";
import { createRequestDedup } from "../../src/gateway/dedup.js";
import type { WebhookServer } from "../../src/gateway/server.js";
import { createWebhookServer } from "../../src/gateway/server.js";
import type { WebhookProvider } from "../../src/gateway/types.js";

let running: WebhookServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function makeConfig(requireSignature: boolean): ResolvedConfig {
  return {
    signingKey: "whsec_test",
    gateway: { ...defaultGatewayConfig(), requireSignature },
  } as unknown as ResolvedConfig;
}

function testProvider(over: Partial<WebhookProvider> = {}): WebhookProvider {
  return {
    name: "test",
    matches: vi.fn((h) => "x-test-provider" in h),
    verify: vi.fn(() => true),
    secretEnvVar: () => undefined,
    ...over,
  };
}

async function start(deps: Parameters<typeof createWebhookServer>[0]): Promise<string> {
  const server = createWebhookServer(deps);
  running = server;
  await server.listen("127.0.0.1", 0);
  const { port } = server.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    config: makeConfig(true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    dedup: createRequestDedup(),
    providers: [testProvider()],
    onEvent: vi.fn(async () => true),
    ...over,
  } as Parameters<typeof createWebhookServer>[0];
}

const WEBHOOK_HEADERS = {
  "content-type": "application/json",
  "x-test-provider": "1",
};

describe("GET /health", () => {
  it("returns 200 with an ok body", async () => {
    const url = await start(baseDeps());
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe("POST /webhook", () => {
  it("dispatches a verified event and acks with 200", async () => {
    const deps = baseDeps();
    const url = await start(deps);

    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: WEBHOOK_HEADERS,
      body: JSON.stringify({ event_type: "message.received" }),
    });

    expect(res.status).toBe(200);
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
    expect((deps.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      provider: "test",
      eventType: "message.received",
    });
  });

  it("rejects a bad signature with 401 and never dispatches", async () => {
    const deps = baseDeps({ providers: [testProvider({ verify: vi.fn(() => false) })] });
    const url = await start(deps);

    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: WEBHOOK_HEADERS,
      body: JSON.stringify({ event_type: "message.received" }),
    });

    expect(res.status).toBe(401);
    expect(deps.onEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when no provider claims the request", async () => {
    const deps = baseDeps({ providers: [] });
    const url = await start(deps);

    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_type: "message.received" }),
    });

    expect(res.status).toBe(400);
    expect(deps.onEvent).not.toHaveBeenCalled();
  });

  it("dedupes a repeated request id, acking the retry without re-dispatching", async () => {
    const deps = baseDeps();
    const url = await start(deps);
    const send = () =>
      fetch(`${url}/webhook`, {
        method: "POST",
        headers: { ...WEBHOOK_HEADERS, "x-inkbox-request-id": "req-42" },
        body: JSON.stringify({ event_type: "message.received" }),
      });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ deduped: true });
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
  });

  it("rolls back the request id and returns 500 when dispatch reports failure", async () => {
    const dedup = createRequestDedup();
    const rollback = vi.spyOn(dedup, "rollback");
    const deps = baseDeps({ dedup, onEvent: vi.fn(async () => false) });
    const url = await start(deps);

    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { ...WEBHOOK_HEADERS, "x-inkbox-request-id": "req-fail" },
      body: JSON.stringify({ event_type: "message.received" }),
    });

    expect(res.status).toBe(500);
    expect(rollback).toHaveBeenCalledWith("req-fail");
  });
});
