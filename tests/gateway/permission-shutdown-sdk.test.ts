import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { expect, it, vi } from "vitest";
import { createEscalationBridge } from "../../src/gateway/escalation.js";
import { createStateStore } from "../../src/gateway/state.js";

it("aborts an actual published-SDK shutdown request to a hung loopback host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-close-sdk-"));
  const state = createStateStore(directory);
  let observed: (request: { path: string; body: string }) => void = () => {};
  const received = new Promise<{ path: string; body: string }>((resolve) => {
    observed = resolve;
  });
  let disconnected = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    response.once("close", () => {
      disconnected = true;
    });
    observed({ path: request.url ?? "", body });
    // Deliberately no response: exercise the real SDK's fetch cancellation.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  const bridge = createEscalationBridge({
    opencode: client,
    state,
    directory,
    timeoutMs: 30000,
    logger: { info() {}, warn() {}, error() {} },
    chatKeyForSession: (session) => (session === "owned-session" ? "owned-chat" : undefined),
    relay: {
      ask: (_key, _prompt, _target, options) =>
        new Promise<string | undefined>((resolve) => {
          options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    },
  });
  const handling = bridge.handlePermission({
    permissionID: "owned-permission",
    sessionID: "owned-session",
    title: "Synthetic permission",
  });
  try {
    const start = performance.now();
    const closed = bridge.close();
    const rejected = expect(closed).rejects.toThrow();
    const request = await received;
    expect(new URL(request.path, "http://localhost").pathname).toBe(
      "/session/owned-session/permissions/owned-permission",
    );
    expect(JSON.parse(request.body)).toEqual({ response: "reject" });
    await rejected;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(9000);
    await vi.waitFor(() => expect(disconnected).toBe(true));
    await handling;
    expect(createStateStore(directory).listPermissions()).toEqual([
      expect.objectContaining({
        permissionID: "owned-permission",
        state: "responding",
        response: "reject",
      }),
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bridge.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
