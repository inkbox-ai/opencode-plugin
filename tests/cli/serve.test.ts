import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENCODE_SERVER_URL,
  ensureOpencodeServer,
  resolveOpencodeBin,
  type ServeChild,
} from "../../src/cli/serve.js";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import type { GatewayLogger } from "../../src/gateway/types.js";

function makeConfig(gateway: Partial<ResolvedConfig["gateway"]> = {}): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    gateway: { ...defaultGatewayConfig(), projectDirectory: "/work", ...gateway },
  };
}

function makeLogger() {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: GatewayLogger = {
    info: (m) => infos.push(m),
    warn: () => {},
    error: (m) => errors.push(m),
  };
  return { logger, errors, infos };
}

// A controllable stand-in for the spawned `opencode serve` process.
class FakeChild implements ServeChild {
  pid = 4242;
  killed: string[] = [];
  exitOnKill = true;
  private handlers: Record<string, Array<(arg: unknown) => void>> = {};

  once(event: string, cb: (arg: never) => void): this {
    this.handlers[event] ??= [];
    this.handlers[event].push(cb as (arg: unknown) => void);
    return this;
  }

  emit(event: "exit" | "error", arg: number | null | Error): void {
    const hs = this.handlers[event] ?? [];
    this.handlers[event] = [];
    for (const h of hs) h(arg);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    if (this.exitOnKill) this.emit("exit", 0);
    return true;
  }
}

describe("resolveOpencodeBin", () => {
  it("keeps a pathy bin and a PATH hit as-is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-bin-"));
    try {
      fs.writeFileSync(path.join(dir, "opencode"), "#!/bin/sh\n");
      expect(resolveOpencodeBin("/opt/opencode", { PATH: "" }, "/x/node")).toBe("/opt/opencode");
      expect(resolveOpencodeBin("opencode", { PATH: dir }, "/x/node")).toBe("opencode");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a sibling of the running node when PATH misses", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-bin-"));
    try {
      fs.writeFileSync(path.join(dir, "opencode"), "#!/bin/sh\n");
      const resolved = resolveOpencodeBin("opencode", { PATH: "/nowhere" }, path.join(dir, "node"));
      expect(resolved).toBe(path.join(dir, "opencode"));
      // No sibling either: the bare name comes back for spawn to report.
      expect(resolveOpencodeBin("opencode", { PATH: "/nowhere" }, "/also/nowhere/node")).toBe(
        "opencode",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureOpencodeServer", () => {
  it("attaches to an explicitly configured server that answers", async () => {
    const { logger } = makeLogger();
    const probe = vi.fn(async () => true);
    const server = await ensureOpencodeServer(
      makeConfig({ serverUrl: "http://127.0.0.1:9999" }),
      logger,
      { probe },
    );
    expect(server).toMatchObject({ url: "http://127.0.0.1:9999", owned: false });
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:9999");
  });

  it("fails hard when an explicitly configured server is down", async () => {
    const { logger, errors } = makeLogger();
    const spawnServe = vi.fn();
    const server = await ensureOpencodeServer(
      makeConfig({ serverUrl: "http://127.0.0.1:9999" }),
      logger,
      { probe: async () => false, spawnServe },
    );
    expect(server).toBeUndefined();
    expect(spawnServe).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("http://127.0.0.1:9999");
  });

  it("attaches to a server already answering on the default URL", async () => {
    const { logger } = makeLogger();
    const probe = vi.fn(async (url: string) => url === DEFAULT_OPENCODE_SERVER_URL);
    const spawnServe = vi.fn();
    const server = await ensureOpencodeServer(makeConfig(), logger, { probe, spawnServe });
    expect(server).toMatchObject({ url: DEFAULT_OPENCODE_SERVER_URL, owned: false });
    expect(spawnServe).not.toHaveBeenCalled();
  });

  it("spawns a managed server when nothing answers, then owns it", async () => {
    const { logger } = makeLogger();
    const child = new FakeChild();
    let managedProbes = 0;
    const probe = vi.fn(async (url: string) => {
      if (url === DEFAULT_OPENCODE_SERVER_URL) return false;
      managedProbes += 1;
      return managedProbes >= 3; // ready on the third poll
    });
    const spawnServe = vi.fn(() => child);
    const server = await ensureOpencodeServer(makeConfig(), logger, {
      probe,
      spawnServe,
      pollMs: 1,
    });
    expect(spawnServe).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4097", "--hostname", "127.0.0.1"],
      expect.objectContaining({ cwd: "/work" }),
    );
    expect(server).toMatchObject({ url: "http://127.0.0.1:4097", owned: true });

    await server?.stop();
    expect(child.killed).toContain("SIGTERM");
  });

  it("fires onExit when an owned server dies, but not after stop()", async () => {
    const { logger } = makeLogger();
    const child = new FakeChild();
    const probe = async (url: string) => url.includes("4097");
    const server = await ensureOpencodeServer(makeConfig(), logger, {
      probe,
      spawnServe: () => child,
      pollMs: 1,
    });
    const exits: Array<number | null> = [];
    server?.onExit((code) => exits.push(code));
    child.emit("exit", 1);
    expect(exits).toEqual([1]);

    // A second server stopped deliberately never fires its callback.
    const child2 = new FakeChild();
    const server2 = await ensureOpencodeServer(makeConfig(), logger, {
      probe,
      spawnServe: () => child2,
      pollMs: 1,
    });
    const exits2: Array<number | null> = [];
    server2?.onExit((code) => exits2.push(code));
    await server2?.stop();
    expect(exits2).toEqual([]);
  });

  it("reports a missing opencode binary distinctly", async () => {
    const { logger, errors } = makeLogger();
    const child = new FakeChild();
    const server = ensureOpencodeServer(makeConfig(), logger, {
      probe: async () => false,
      spawnServe: () => {
        setImmediate(() => {
          const err = new Error("spawn opencode ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          child.emit("error", err);
        });
        return child;
      },
      pollMs: 1,
    });
    expect(await server).toBeUndefined();
    expect(errors.join(" ")).toMatch(/binary "opencode" not found/);
  });

  it("fails when the child exits before becoming reachable", async () => {
    const { logger, errors } = makeLogger();
    const child = new FakeChild();
    const server = ensureOpencodeServer(makeConfig(), logger, {
      probe: async () => false,
      spawnServe: () => {
        setImmediate(() => child.emit("exit", 7));
        return child;
      },
      pollMs: 1,
    });
    expect(await server).toBeUndefined();
    expect(errors.join(" ")).toContain("exited (code 7)");
  });

  it("times out and kills a child that never becomes reachable", async () => {
    const { logger, errors } = makeLogger();
    const child = new FakeChild();
    const server = await ensureOpencodeServer(makeConfig(), logger, {
      probe: async (url: string) => url === DEFAULT_OPENCODE_SERVER_URL && false,
      spawnServe: () => child,
      pollMs: 1,
      timeoutMs: 10,
    });
    expect(server).toBeUndefined();
    expect(child.killed).toContain("SIGKILL");
    expect(errors.join(" ")).toContain("did not become reachable");
  });

  it("honors gateway.serve bin/port overrides", async () => {
    const { logger } = makeLogger();
    const child = new FakeChild();
    const spawnServe = vi.fn(() => child);
    const server = await ensureOpencodeServer(
      makeConfig({ serve: { bin: "/opt/opencode", port: 5001 } }),
      logger,
      { probe: async (url: string) => url.includes("5001"), spawnServe, pollMs: 1 },
    );
    expect(spawnServe).toHaveBeenCalledWith(
      "/opt/opencode",
      ["serve", "--port", "5001", "--hostname", "127.0.0.1"],
      expect.anything(),
    );
    expect(server?.url).toBe("http://127.0.0.1:5001");
  });
});
