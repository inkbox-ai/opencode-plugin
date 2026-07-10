import { describe, expect, it } from "vitest";
import { runSetup } from "../../src/cli/setup.js";
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

function render(config: ResolvedConfig): { code: number; out: string } {
  const lines: string[] = [];
  const code = runSetup(config, { print: (line) => lines.push(line) });
  return { code, out: lines.join("\n") };
}

describe("runSetup", () => {
  it("prints the required env var names and the wrapper snippet", () => {
    const { code, out } = render(makeConfig());
    expect(code).toBe(0);
    expect(out).toContain("INKBOX_API_KEY");
    expect(out).toContain("INKBOX_IDENTITY");
    expect(out).toContain("INKBOX_SIGNING_KEY");
    expect(out).toContain("@inkbox/opencode-plugin");
    expect(out).toContain(".opencode/plugins/inkbox.ts");
    expect(out).toContain("InkboxPlugin(input, {");
    expect(out).toContain("gateway: {");
    expect(out).toContain("enabled: true");
  });

  it("reflects which credentials are already set vs missing", () => {
    const { out } = render(makeConfig({ apiKey: undefined }));
    expect(out).toContain("INKBOX_API_KEY");
    expect(out).toMatch(/INKBOX_API_KEY\s+\(MISSING\)/);
    expect(out).toMatch(/INKBOX_IDENTITY\s+\(set\)/);
  });

  it("notes the console/CLI provisioning and START opt-in steps", () => {
    const { out } = render(makeConfig());
    expect(out).toMatch(/iMessage/i);
    expect(out).toContain("START");
    expect(out).toContain("inkbox-opencode doctor");
  });

  it("documents the managed serve fallback and boot autostart", () => {
    const { out } = render(makeConfig());
    expect(out).toContain("autostart install");
    expect(out).toMatch(/managed server \(port 4097\)/);
    expect(out).toContain("loginctl enable-linger");
  });
});
