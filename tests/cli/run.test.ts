import { beforeEach, describe, expect, it, vi } from "vitest";
import { runForeground } from "../../src/cli/run.js";
import { ensureOpencodeServer, opencodeReachable } from "../../src/cli/serve.js";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import { startGateway } from "../../src/gateway/index.js";
import type { GatewayLogger } from "../../src/gateway/types.js";

vi.mock("../../src/gateway/index.js", () => ({
  startGateway: vi.fn(),
}));

vi.mock("../../src/cli/serve.js", () => ({
  DEFAULT_OPENCODE_SERVER_URL: "http://127.0.0.1:4096",
  ensureOpencodeServer: vi.fn(),
  opencodeReachable: vi.fn(async () => true),
  opencodeBinAvailable: vi.fn(() => true),
}));

function makeConfig(): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    gateway: defaultGatewayConfig(),
  };
}

const logger: GatewayLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Each runForeground call registers one-shot SIGINT/SIGTERM listeners that a
// non-signal exit leaves behind; harmless for this small suite.
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runForeground", () => {
  it("fails fast without credentials", async () => {
    const config = { ...makeConfig(), apiKey: undefined };
    expect(await runForeground(config, logger)).toBe(1);
    expect(ensureOpencodeServer).not.toHaveBeenCalled();
  });

  it("fails when an injected opencode client is unreachable", async () => {
    vi.mocked(opencodeReachable).mockResolvedValueOnce(false);
    const code = await runForeground(makeConfig(), logger, { opencode: {} as never });
    expect(code).toBe(1);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("returns 1 when no opencode server can be ensured", async () => {
    vi.mocked(ensureOpencodeServer).mockResolvedValueOnce(undefined);
    expect(await runForeground(makeConfig(), logger, { runtime: {} as never })).toBe(1);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("stops a managed server when startGateway throws", async () => {
    const stop = vi.fn(async () => {});
    vi.mocked(ensureOpencodeServer).mockResolvedValueOnce({
      url: "http://127.0.0.1:4097",
      owned: true,
      onExit: () => {},
      stop,
    });
    vi.mocked(startGateway).mockRejectedValueOnce(new Error("tunnel down"));
    await expect(runForeground(makeConfig(), logger, { runtime: {} as never })).rejects.toThrow(
      "tunnel down",
    );
    expect(stop).toHaveBeenCalled();
  });

  it("exits nonzero and closes the gateway when the managed server dies", async () => {
    const handle = { publicUrl: "https://tunnel.example", close: vi.fn(async () => {}) };
    vi.mocked(startGateway).mockResolvedValueOnce(handle as never);

    let exitCb: (code: number | null) => void = () => {};
    const stop = vi.fn(async () => {});
    vi.mocked(ensureOpencodeServer).mockResolvedValueOnce({
      url: "http://127.0.0.1:4097",
      owned: true,
      onExit: (cb) => {
        exitCb = cb;
      },
      stop,
    });

    const running = runForeground(makeConfig(), logger, { runtime: {} as never });
    await vi.waitFor(() => expect(startGateway).toHaveBeenCalled());
    exitCb(137);

    expect(await running).toBe(1);
    expect(handle.close).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });
});
