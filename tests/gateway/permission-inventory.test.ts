import { createServer, type Server } from "node:http";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { expect, it, vi } from "vitest";
import { createNativePermissionInventory } from "../../src/gateway/permission-inventory.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("uses the supplied SDK transport, custom fetch, authentication and directory without mutation", async () => {
  const seen: { path: string; authorization: string | undefined; header: string | undefined }[] =
    [];
  const rows = [{ id: "permission-fixture", sessionID: "session-fixture", permission: "bash" }];
  const server = createServer((request, response) => {
    seen.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      header: request.headers["x-transport-fixture"] as string | undefined,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.startsWith("/permission") ? rows : {}));
  });
  try {
    const baseUrl = await listen(server);
    const directory = "/workspace/space and #suffix";
    const customFetch = vi.fn((request: Request) => fetch(request));
    const client = createOpencodeClient({
      baseUrl,
      directory,
      headers: { authorization: "Basic synthetic", "x-transport-fixture": "same-client" },
      fetch: customFetch,
    });
    const transport = (client as any)._client;
    const before = transport.getConfig();
    const result = await createNativePermissionInventory(client).list(
      directory,
      new AbortController().signal,
    );
    expect(result).toEqual(rows);
    expect(customFetch).toHaveBeenCalledTimes(1);
    const url = new URL(seen[0]?.path ?? "", baseUrl);
    expect(url.pathname).toBe("/permission");
    expect(url.searchParams.get("directory")).toBe(directory);
    expect(seen[0]).toMatchObject({ authorization: "Basic synthetic", header: "same-client" });
    expect((client as any)._client).toBe(transport);
    expect(transport.getConfig()).toEqual(before);
    expect(transport.getConfig().fetch).toBe(customFetch);
    await client.session.status({ query: { directory } });
    expect(customFetch).toHaveBeenCalledTimes(2);
    expect(new URL(seen[1]?.path ?? "", baseUrl).pathname).toBe("/session/status");
    expect(seen[1]).toMatchObject({ authorization: "Basic synthetic", header: "same-client" });
  } finally {
    await close(server);
  }
});

it.each([
  { status: 503, body: '{"error":"synthetic unavailable"}' },
  { status: 200, body: '{"pending":[]}' },
  { status: 200, body: "null" },
  { status: 200, body: "not-json" },
  { status: 200, body: '[{"id":"request"}]' },
  { status: 200, body: '[{"id":1,"sessionID":"session"}]' },
  { status: 200, body: '[{"id":"request","sessionID":null}]' },
  { status: 200, body: "[null]" },
])(
  "does not turn an unavailable or malformed inventory into empty success ($status/$body)",
  async ({ status, body }) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
    try {
      const client = createOpencodeClient({ baseUrl: await listen(server) });
      await expect(
        createNativePermissionInventory(client).list("/workspace", new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      await close(server);
    }
  },
);

it("accepts an actual successful empty native inventory", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  try {
    const client = createOpencodeClient({ baseUrl: await listen(server) });
    await expect(
      createNativePermissionInventory(client).list("/workspace", new AbortController().signal),
    ).resolves.toEqual([]);
  } finally {
    await close(server);
  }
});

it("rejects unsupported host transports before any network request", async () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    for (const transport of [
      undefined,
      {},
      { get() {} },
      { getConfig() {} },
      { get: 1, getConfig() {} },
    ]) {
      const client = { _client: transport } as unknown as OpencodeClient;
      await expect(
        createNativePermissionInventory(client).list("/workspace", new AbortController().signal),
      ).rejects.toThrow("transport is unavailable");
    }
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it("cancels a real hanging native inventory request through the supplied SDK transport", async () => {
  let received: () => void = () => {};
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  let disconnected = false;
  const server = createServer((_request, response) => {
    response.once("close", () => {
      disconnected = true;
    });
    received();
  });
  const controller = new AbortController();
  try {
    const customFetch = vi.fn((request: Request) => fetch(request));
    const client = createOpencodeClient({ baseUrl: await listen(server), fetch: customFetch });
    const pending = createNativePermissionInventory(client).list("/workspace", controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await requestReceived;
    expect(customFetch).toHaveBeenCalledTimes(1);
    controller.abort(new Error("Synthetic inventory cancellation"));
    await rejected;
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(customFetch.mock.calls[0]?.[0].signal.aborted).toBe(true);
  } finally {
    controller.abort();
    await close(server);
  }
});
