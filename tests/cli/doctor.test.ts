import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { type Finding, runDoctor } from "../../src/cli/doctor.js";
import { NOT_CONFIGURED_MESSAGE } from "../../src/client.js";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    signingKey: "sig",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    gateway: defaultGatewayConfig(),
    ...overrides,
  };
}

function healthyRuntime() {
  return {
    getClient: vi.fn(async () => ({
      whoami: vi.fn(async () => ({
        authType: "api_key",
        authSubtype: "api_key.agent_scoped.claimed",
      })),
    })),
    getIdentity: vi.fn(async () => ({
      agentHandle: "agent",
      displayName: "Agent",
      emailAddress: "agent@inkbox.ai",
      phoneNumber: { number: "+15550001111" },
    })),
  } as any;
}

function reachableOpencode(): OpencodeClient {
  return { config: { get: vi.fn(async () => ({ data: {} })) } } as unknown as OpencodeClient;
}

function unreachableOpencode(): OpencodeClient {
  return {
    config: {
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    },
  } as unknown as OpencodeClient;
}

function collect() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

function isFindingShape(f: Finding): boolean {
  return (
    (f.severity === "error" || f.severity === "warning" || f.severity === "info") &&
    typeof f.message === "string"
  );
}

describe("runDoctor", () => {
  it("returns ok with well-formed findings when everything resolves", async () => {
    const { lines, print } = collect();
    const result = await runDoctor(makeConfig(), {
      runtime: healthyRuntime(),
      opencode: reachableOpencode(),
      print,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.every(isFindingShape)).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("agent@inkbox.ai");
    expect(out).toContain("opencode server reachable");
    expect(out).toContain("doctor: ok");
  });

  it("reports a config error and skips the Inkbox calls when credentials are missing", async () => {
    const runtime = healthyRuntime();
    const result = await runDoctor(makeConfig({ apiKey: undefined, identity: undefined }), {
      runtime,
      opencode: reachableOpencode(),
      print: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.message === NOT_CONFIGURED_MESSAGE)).toBe(true);
    expect(runtime.getClient).not.toHaveBeenCalled();
  });

  it("surfaces whoami and identity failures as errors", async () => {
    const runtime = {
      getClient: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      getIdentity: vi.fn(async () => {
        throw new Error("no such handle");
      }),
    } as any;
    const result = await runDoctor(makeConfig(), {
      runtime,
      opencode: reachableOpencode(),
      print: () => {},
    });
    expect(result.ok).toBe(false);
    const messages = result.findings.map((f) => f.message).join(" ");
    expect(messages).toContain("connection refused");
    expect(messages).toContain("did not resolve");
  });

  it("flags an unreachable explicitly-configured opencode server as an error", async () => {
    const { lines, print } = collect();
    const result = await runDoctor(
      makeConfig({
        gateway: { ...defaultGatewayConfig(), serverUrl: "http://127.0.0.1:59999" },
      }),
      {
        runtime: healthyRuntime(),
        opencode: unreachableOpencode(),
        print,
      },
    );
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.severity === "error" && /unreachable/.test(f.message)),
    ).toBe(true);
    expect(lines.join("\n")).toContain("doctor: issues found");
  });

  it("treats a down default server as fine when the opencode binary exists", async () => {
    const result = await runDoctor(makeConfig(), {
      runtime: healthyRuntime(),
      opencode: unreachableOpencode(),
      opencodeBinFound: true,
      print: () => {},
    });
    expect(result.ok).toBe(true);
    expect(
      result.findings.some((f) => f.severity === "info" && /launch its own/.test(f.message)),
    ).toBe(true);
  });

  it("errors when nothing answers and the opencode binary is missing", async () => {
    const result = await runDoctor(makeConfig(), {
      runtime: healthyRuntime(),
      opencode: unreachableOpencode(),
      opencodeBinFound: false,
      print: () => {},
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.severity === "error" && /not found on PATH/.test(f.message)),
    ).toBe(true);
  });

  it("warns without failing when no signing key is set", async () => {
    const result = await runDoctor(makeConfig({ signingKey: undefined }), {
      runtime: healthyRuntime(),
      opencode: reachableOpencode(),
      print: () => {},
    });
    expect(result.ok).toBe(true);
    expect(
      result.findings.some((f) => f.severity === "warning" && /INKBOX_SIGNING_KEY/.test(f.message)),
    ).toBe(true);
  });

  it("names the source each credential resolved from, without leaking secrets", async () => {
    const { lines, print } = collect();
    await runDoctor(
      makeConfig({ apiKey: "ApiKey_abcdef123456", identity: "agent", signingKey: undefined }),
      {
        runtime: healthyRuntime(),
        opencode: reachableOpencode(),
        env: { INKBOX_API_KEY: "ApiKey_abcdef123456", INKBOX_IDENTITY: "agent" },
        envSources: new Map([["INKBOX_API_KEY", "/home/u/.inkbox-opencode/.env"]]),
        print,
      },
    );
    const out = lines.join("\n");
    expect(out).toContain("…123456  — from /home/u/.inkbox-opencode/.env");
    expect(out).toContain("agent  — from shell environment ($INKBOX_IDENTITY)");
    expect(out).toContain("signing key: (not set)");
    expect(out).not.toContain("ApiKey_abcdef123456"); // only the suffix is shown
  });

  it("calls out a shell export shadowing a different key in the wizard's env file", async () => {
    // Dima's setup: the wizard saved a fresh key to the state-dir .env, but a
    // stale shell export wins for every new process and the API 401s.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-doctor-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-doctor-cwd-"));
    try {
      fs.writeFileSync(path.join(home, ".env"), "INKBOX_API_KEY=ApiKey_fresh\n");
      const runtime = {
        getClient: vi.fn(async () => {
          throw new Error("Inkbox API error (401): Unauthorized");
        }),
        getIdentity: vi.fn(async () => {
          throw new Error("Inkbox API error (401): Unauthorized");
        }),
      } as any;
      const result = await runDoctor(makeConfig({ apiKey: "ApiKey_stale" }), {
        runtime,
        opencode: reachableOpencode(),
        env: { INKBOX_OPENCODE_HOME: home, INKBOX_API_KEY: "ApiKey_stale" },
        envSources: new Map(), // nothing loaded from files → the shell won
        cwd,
        print: () => {},
      });
      const shadow = result.findings.find((f) => /exported by your shell/.test(f.message));
      expect(shadow?.severity).toBe("warning");
      expect(shadow?.message).toContain("$INKBOX_API_KEY");
      expect(shadow?.message).toContain(path.join(home, ".env"));
      expect(shadow?.message).toContain("unset INKBOX_API_KEY");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stays quiet about shadowing when the values agree", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-doctor-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-doctor-cwd-"));
    try {
      fs.writeFileSync(path.join(home, ".env"), "INKBOX_API_KEY=ApiKey_same\n");
      const result = await runDoctor(makeConfig({ apiKey: "ApiKey_same" }), {
        runtime: healthyRuntime(),
        opencode: reachableOpencode(),
        env: { INKBOX_OPENCODE_HOME: home, INKBOX_API_KEY: "ApiKey_same" },
        envSources: new Map([["INKBOX_API_KEY", path.join(home, ".env")]]),
        cwd,
        print: () => {},
      });
      expect(result.findings.some((f) => /overrides a different value/.test(f.message))).toBe(
        false,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("echoes the resolved gateway settings", async () => {
    const { lines, print } = collect();
    await runDoctor(makeConfig(), {
      runtime: healthyRuntime(),
      opencode: reachableOpencode(),
      print,
    });
    const out = lines.join("\n");
    expect(out).toContain("mode:");
    expect(out).toContain("voice:");
    expect(out).toContain("bind:");
  });
});
