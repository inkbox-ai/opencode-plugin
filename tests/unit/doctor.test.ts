import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NOT_CONFIGURED_MESSAGE } from "../../src/client.js";
import type { ResolvedConfig } from "../../src/config.js";
import { doctorTools } from "../../src/tools/doctor.js";
import type { GatingSummary } from "../../src/tools/registry.js";
import type { ToolDeps } from "../../src/tools/types.js";

// Deliberately unset in the test environment so the vault-key finding is
// deterministic; individual tests stub it when they need it present.
const VAULT_KEY_ENV_VAR = "INKBOX_DOCTOR_TEST_VAULT_KEY";

const GATING: GatingSummary = {
  enabled: ["inkbox_doctor", "inkbox_send_email"],
  disabledByDefault: [{ name: "inkbox_place_call", group: "calls", sensitive: false }],
  groups: ["diagnostics", "email", "calls"],
};

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: "k",
    identity: "agent",
    signingKey: "sig",
    vaultKeyEnvVar: VAULT_KEY_ENV_VAR,
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    ...overrides,
  };
}

function makeHealthyRuntime() {
  return {
    getClient: vi.fn(async () => ({
      whoami: vi.fn(async () => ({
        authType: "api_key",
        authSubtype: "api_key_agent_scoped_claimed",
      })),
    })),
    getIdentity: vi.fn(async () => ({
      agentHandle: "agent",
      displayName: "Agent",
      emailAddress: "agent@inkbox.ai",
      phoneNumber: { number: "+15550001111" },
    })),
  };
}

function makeDeps(config: ResolvedConfig, runtime = makeHealthyRuntime()) {
  const deps = {
    runtime,
    config,
    vault: { keyEnvVar: VAULT_KEY_ENV_VAR, getCredentials: vi.fn() },
  } as unknown as ToolDeps;
  return { deps, runtime };
}

async function runDoctor(deps: ToolDeps, getGating: () => GatingSummary = () => GATING) {
  const [tool] = doctorTools(deps, getGating);
  return (await tool.definition.execute({}, {} as any)) as { title: string; output: string };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("doctorTools", () => {
  it("registers inkbox_doctor in the diagnostics group, enabled by default, with no args", () => {
    const { deps } = makeDeps(makeConfig());
    const tools = doctorTools(deps, () => GATING);
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.name).toBe("inkbox_doctor");
    expect(tool.group).toBe("diagnostics");
    expect(tool.defaultEnabled).toBe(true);
    expect(tool.sensitive).toBeFalsy();
    expect(z.object(tool.definition.args).safeParse({}).success).toBe(true);
  });

  it("reports a configuration error and skips network checks when credentials are missing", async () => {
    const { deps, runtime } = makeDeps(makeConfig({ apiKey: undefined, identity: undefined }));
    const result = await runDoctor(deps);
    expect(result.title).toBe("Inkbox doctor: issues found");
    expect(result.output).toContain("issues found");
    expect(result.output).toContain(NOT_CONFIGURED_MESSAGE);
    expect(runtime.getClient).not.toHaveBeenCalled();
    expect(runtime.getIdentity).not.toHaveBeenCalled();
  });

  it("surfaces whoami and identity failures as error findings", async () => {
    const runtime = {
      getClient: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      getIdentity: vi.fn(async () => {
        throw new Error("no such handle");
      }),
    };
    const { deps } = makeDeps(makeConfig(), runtime);
    const result = await runDoctor(deps);
    expect(result.title).toBe("Inkbox doctor: issues found");
    expect(result.output).toContain("whoami() failed: connection refused");
    expect(result.output).toContain("did not resolve: no such handle");
    // The report names the identity that failed to resolve.
    expect(result.output).toContain("agent");
  });

  it("reports ok when whoami and the identity resolve", async () => {
    const { deps, runtime } = makeDeps(makeConfig());
    const result = await runDoctor(deps);
    expect(result.title).toBe("Inkbox doctor: ok");
    expect(result.output).toContain("everything looks good");
    expect(result.output).toContain("agent@inkbox.ai");
    expect(result.output).toContain("+15550001111");
    expect(runtime.getClient).toHaveBeenCalledTimes(1);
    expect(runtime.getIdentity).toHaveBeenCalledTimes(1);
  });

  it("includes the tool-gating summary in the report", async () => {
    const { deps } = makeDeps(makeConfig());
    const getGating = vi.fn(() => GATING);
    const result = await runDoctor(deps, getGating);
    expect(getGating).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("inkbox_send_email");
    expect(result.output).toContain("Disabled tools");
    expect(result.output).toContain("inkbox_place_call");
  });

  it("warns without failing when the credential is not an api_key", async () => {
    const runtime = makeHealthyRuntime();
    runtime.getClient = vi.fn(async () => ({
      whoami: vi.fn(async () => ({ authType: "session", authSubtype: "n/a" })),
    }));
    const { deps } = makeDeps(makeConfig(), runtime);
    const result = await runDoctor(deps);
    expect(result.output).toContain("Authenticated as session; expected an api_key credential.");
    expect(result.title).toBe("Inkbox doctor: ok");
  });

  it("warns without failing when no signing key is configured", async () => {
    const { deps } = makeDeps(makeConfig({ signingKey: undefined }));
    const result = await runDoctor(deps);
    expect(result.output).toContain("INKBOX_SIGNING_KEY");
    expect(result.title).toBe("Inkbox doctor: ok");
  });

  it("notes when the vault unlock key is absent and stays quiet when it is set", async () => {
    const { deps } = makeDeps(makeConfig());
    const absent = await runDoctor(deps);
    expect(absent.output).toContain(`Vault unlock key not present (${VAULT_KEY_ENV_VAR})`);

    vi.stubEnv(VAULT_KEY_ENV_VAR, "unlock-key");
    const present = await runDoctor(deps);
    expect(present.output).not.toContain("Vault unlock key not present");
  });
});
