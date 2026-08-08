import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mock: ChildProcess | undefined;
let baseUrl = "";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a mock port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/v1/models`);
      if (response.ok) return;
    } catch {
      // The child has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("mock model did not start");
}

async function complete(nonce: string, stream: boolean): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock-model",
      stream,
      messages: [{ role: "user", content: `ping ${nonce}` }],
    }),
  });
}

beforeAll(async () => {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  mock = spawn(process.execPath, ["tests/live/mock-openai.mjs", String(port)], {
    stdio: "ignore",
  });
  await waitUntilReady();
});

afterAll(() => {
  mock?.kill();
});

describe("live OpenAI mock contract", () => {
  it("uses a unique completion id for consecutive responses", async () => {
    const first = await complete("smoke-11111111", false);
    const second = await complete("smoke-22222222", false);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstBody = (await first.json()) as any;
    const secondBody = (await second.json()) as any;
    expect(firstBody.id).toMatch(/^chatcmpl-/);
    expect(secondBody.id).toMatch(/^chatcmpl-/);
    expect(firstBody.id).not.toBe(secondBody.id);
    expect(firstBody.choices[0].message.content).toContain("smoke-11111111");
    expect(secondBody.choices[0].message.content).toContain("smoke-22222222");
  });

  it("keeps one unique id across every chunk of a streamed response", async () => {
    const first = await complete("smoke-33333333", true);
    const second = await complete("smoke-44444444", true);
    const chunks = async (response: Response) =>
      (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {") && !line.endsWith("[DONE]"))
        .map((line) => JSON.parse(line.slice("data: ".length)));
    const firstChunks = await chunks(first);
    const secondChunks = await chunks(second);
    expect(new Set(firstChunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(new Set(secondChunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(firstChunks[0].id).not.toBe(secondChunks[0].id);
    expect(JSON.stringify(firstChunks)).toContain("smoke-33333333");
    expect(JSON.stringify(secondChunks)).toContain("smoke-44444444");
  });
});
