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

  it("flags an unreachable opencode server as an error", async () => {
    const { lines, print } = collect();
    const result = await runDoctor(makeConfig(), {
      runtime: healthyRuntime(),
      opencode: unreachableOpencode(),
      print,
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.severity === "error" && /unreachable/.test(f.message)),
    ).toBe(true);
    expect(lines.join("\n")).toContain("doctor: issues found");
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
