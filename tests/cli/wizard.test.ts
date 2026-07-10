import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWizard, type WizardDeps, type WizardIO, type WizardSdk } from "../../src/cli/wizard.js";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-wizard-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    gateway: defaultGatewayConfig(),
    ...overrides,
  };
}

// Queue-driven IO: answers are consumed in call order across ask/confirm/choose.
function scriptedIO(answers: Array<string | boolean | number>) {
  const queue = [...answers];
  const lines: string[] = [];
  const next = () => {
    if (queue.length === 0) throw new Error(`IO queue exhausted after: ${lines.at(-1)}`);
    return queue.shift();
  };
  const io: WizardIO = {
    print: (line = "") => {
      lines.push(line);
    },
    ask: async () => String(next()),
    confirm: async () => Boolean(next()),
    choose: async () => Number(next()),
  };
  return { io, lines, queue };
}

interface FakeWorld {
  identity: Record<string, unknown> & {
    update: ReturnType<typeof vi.fn>;
    provisionPhoneNumber: ReturnType<typeof vi.fn>;
    createSigningKey: ReturnType<typeof vi.fn>;
  };
  client: Record<string, unknown>;
  sdk: WizardSdk;
  signup: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  resend: ReturnType<typeof vi.fn>;
}

function fakeWorld(over: { phone?: unknown; imessageEnabled?: boolean } = {}): FakeWorld {
  const identity: FakeWorld["identity"] = {
    agentHandle: "test-agent",
    emailAddress: "test-agent@inkboxmail.com",
    phoneNumber: over.phone ?? null,
    imessageEnabled: over.imessageEnabled ?? false,
    id: "id-1",
    update: vi.fn(async () => ({})),
    provisionPhoneNumber: vi.fn(async () => ({
      id: "pn-1",
      number: "+15550001111",
      type: "local",
    })),
    createSigningKey: vi.fn(async () => ({ signingKey: "whsec_minted" })),
  };
  const client = {
    whoami: vi.fn(async () => ({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    })),
    listIdentities: vi.fn(async () => [{ agentHandle: "test-agent" }]),
    getIdentity: vi.fn(async () => identity),
    apiKeys: { create: vi.fn(async () => ({ apiKey: "ApiKey_scoped" })) },
    texts: {
      list: vi.fn(async () => [
        { direction: "inbound", text: "START", remotePhoneNumber: "+15551112222" },
      ]),
    },
  };
  const signup = vi.fn(async () => ({
    apiKey: "ApiKey_new",
    agentHandle: "test-agent",
    emailAddress: "test-agent@inkboxmail.com",
  }));
  const verify = vi.fn(async () => ({ claimStatus: "claimed" }));
  const resend = vi.fn(async () => {});
  const sdk: WizardSdk = {
    signup,
    verifySignup: verify,
    resendVerification: resend,
    client: async () => client,
  };
  return { identity, client, sdk, signup, verify, resend };
}

function deps(
  world: FakeWorld,
  io: WizardIO,
  over: Partial<WizardDeps> = {},
): WizardDeps & { envFilePath: string } {
  return {
    io,
    env: {},
    envFilePath: path.join(tmp, ".env"),
    sdk: () => world.sdk,
    fetchFn: vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    installAutostartFn: vi.fn(async () => true),
    startDaemonFn: vi.fn(async () => 0),
    sleep: async () => {},
    cwd: tmp,
    ...over,
  };
}

function savedEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("runWizard", () => {
  it("exits early when already configured and reconfigure is declined", async () => {
    const world = fakeWorld();
    const { io } = scriptedIO([false]); // reconfigure? no
    const d = deps(world, io);
    const code = await runWizard(makeConfig({ apiKey: "k", identity: "agent" }), d);
    expect(code).toBe(0);
    expect(fs.existsSync(d.envFilePath)).toBe(false);
  });

  it("walks the full self-signup path and persists every setting", async () => {
    const world = fakeWorld();
    const { io } = scriptedIO([
      false, // already have a key? no → self-signup
      "me@example.com", // signup email
      "test-agent", // handle
      "123456", // verification code
      true, // enable iMessage
      true, // provision number
      true, // use realtime
      false, // already have a signing key? no
      true, // mint one
      "", // project dir → default (tmp)
      true, // autostart on boot
    ]);
    const d = deps(world, io, { env: { OPENAI_API_KEY: "sk-test" } });
    const code = await runWizard(makeConfig(), d);
    expect(code).toBe(0);

    const saved = savedEnv(d.envFilePath);
    expect(saved.INKBOX_API_KEY).toBe("ApiKey_new");
    expect(saved.INKBOX_IDENTITY).toBe("test-agent");
    expect(saved.INKBOX_ALLOW_ALL_USERS).toBe("true");
    expect(saved.INKBOX_REALTIME_ENABLED).toBe("true");
    expect(saved.INKBOX_REALTIME_API_KEY).toBe("sk-test");
    expect(saved.INKBOX_SIGNING_KEY).toBe("whsec_minted");
    expect(saved.INKBOX_PROJECT_DIR).toBe(tmp);
    expect(saved.INKBOX_GATEWAY_AGENT).toBe("inkbox-channel");
    expect(fs.statSync(d.envFilePath).mode & 0o777).toBe(0o600);

    expect(world.identity.update).toHaveBeenCalledWith({ imessageEnabled: true });
    expect(world.identity.provisionPhoneNumber).toHaveBeenCalled();
    expect(d.installAutostartFn).toHaveBeenCalledWith(
      expect.objectContaining({ projectDirectory: tmp }),
    );
  });

  it("supports resend after burning the verification attempts", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    world.verify
      .mockRejectedValueOnce(new Error("wrong"))
      .mockRejectedValueOnce(new Error("wrong"))
      .mockRejectedValueOnce(new Error("wrong"))
      .mockResolvedValueOnce({ claimStatus: "claimed" });
    const { io } = scriptedIO([
      false, // no key → signup
      "me@example.com",
      "test-agent",
      "111111", // wrong ×3
      "222222",
      "333333",
      "resend", // resets attempts
      "444444", // correct
      false, // iMessage no
      false, // realtime no (identity has a phone)
      false, // have signing key? no
      true, // mint
      "",
      false, // no boot autostart
      false, // no background start
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(world.resend).toHaveBeenCalledTimes(1);
    expect(world.verify).toHaveBeenCalledTimes(4);
  });

  it("binds an agent-scoped key to its identity", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io } = scriptedIO([
      true, // have a key
      "ApiKey_agent", // pasted key
      false, // iMessage no
      false, // realtime no
      false, // signing key: have one? no
      true, // mint
      "", // project dir
      false, // no boot autostart
      false, // no background start
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(savedEnv(d.envFilePath).INKBOX_API_KEY).toBe("ApiKey_agent");
    expect(savedEnv(d.envFilePath).INKBOX_IDENTITY).toBe("test-agent");
  });

  it("mints a scoped key for an admin credential", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    (world.client.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.admin_scoped",
      organizationId: "org-1",
    });
    const { io } = scriptedIO([
      true, // have a key
      "ApiKey_admin",
      0, // choose the first identity
      false, // iMessage no
      false, // realtime no
      false, // have signing key? no
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(savedEnv(d.envFilePath).INKBOX_API_KEY).toBe("ApiKey_scoped");
  });

  it("fails setup when no signing key is pasted or minted", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io } = scriptedIO([
      true, // have a key
      "ApiKey_agent",
      false, // iMessage no
      false, // realtime no
      false, // have signing key? no
      false, // mint one? no → mandatory failure
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(1);
  });

  it("disables realtime when key validation fails", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io } = scriptedIO([
      true,
      "ApiKey_agent",
      false, // iMessage no
      true, // use realtime
      false, // have signing key? no
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io, {
      env: { OPENAI_API_KEY: "sk-bad" },
      fetchFn: vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
    });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(savedEnv(d.envFilePath).INKBOX_REALTIME_ENABLED).toBe("false");
  });

  it("keeps going when number provisioning is rejected (plan gating)", async () => {
    const world = fakeWorld();
    world.identity.provisionPhoneNumber.mockRejectedValueOnce(new Error("payment required"));
    const { io, lines } = scriptedIO([
      true,
      "ApiKey_agent",
      false, // iMessage no
      true, // provision → fails gracefully
      false, // have signing key? no  (no realtime step: no phone, no imessage)
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(lines.join("\n")).toContain("paid tiers");
  });
});
