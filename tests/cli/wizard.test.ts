import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWizard,
  sanitizePasted,
  type WizardDeps,
  type WizardIO,
  type WizardSdk,
} from "../../src/cli/wizard.js";
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
    voiceAiAuthorityMode: "contact_scoped",
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
  const questions: string[] = [];
  const choiceDefaults: number[] = [];
  const next = () => {
    if (queue.length === 0) throw new Error(`IO queue exhausted after: ${lines.at(-1)}`);
    return queue.shift();
  };
  const io: WizardIO = {
    print: (line = "") => {
      lines.push(line);
    },
    ask: async (question) => {
      questions.push(question);
      return question.includes("Press Enter to continue and set up phone call handling")
        ? ""
        : String(next());
    },
    confirm: async () => Boolean(next()),
    choose: async (question, _options, def) => {
      choiceDefaults.push(def);
      const answer = next();
      if (question.includes("Choose how this agent should handle phone calls")) {
        if (answer === true) return 1;
        if (answer === false) return 2;
      }
      return Number(answer);
    },
  };
  return { io, lines, questions, choiceDefaults, queue };
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
    getHostedAgentConfig: vi.fn(async () => ({ authorityMode: "contact_scoped" })),
    setHostedAgentConfig: vi.fn(async () => ({})),
    setHostedAgentAuthorityMode: vi.fn(async () => ({})),
    getIncomingCallAction: vi.fn(async () => ({ incomingCallAction: "auto_accept" })),
    setIncomingCallAction: vi.fn(async () => ({})),
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
    realtimeValidatorFn: vi.fn(async () => ({ ok: true, detail: "session updated" })),
    installAutostartFn: vi.fn(async () => true),
    startDaemonFn: vi.fn(async () => 0),
    restartDaemonFn: vi.fn(async () => 0),
    // Nothing running when the step begins; a live pid once it has started.
    runningDaemonPidFn: (() => {
      let calls = 0;
      return vi.fn(() => (calls++ === 0 ? undefined : 4242));
    })(),
    confirmTimeoutMs: 0,
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

// Reaches the autostart step over the shortest path: existing key, no channels,
// mint a signing key, default project dir.
const toAutostart = (...autostartAnswers: (string | boolean)[]) => [
  true, // already have a key? yes
  "ApiKey_agent",
  false, // iMessage no
  false, // dedicated number no
  false, // have signing key? no
  true, // mint one
  "", // project dir → default
  ...autostartAnswers,
];

describe("sanitizePasted", () => {
  it("strips bracketed-paste markers around pasted values", () => {
    expect(sanitizePasted("\u001b[200~123456\u001b[201~")).toBe("123456");
    expect(sanitizePasted("[200~ApiKey_abc[201~")).toBe("ApiKey_abc");
    expect(sanitizePasted("plain")).toBe("plain");
  });
});

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
    const code = await runWizard(
      makeConfig({
        callWebsocketUrl: "wss://outbound-only.example/audio",
        gateway: { ...defaultGatewayConfig(), publicUrl: "https://test-agent.example" },
      }),
      d,
    );
    expect(code).toBe(0);

    const saved = savedEnv(d.envFilePath);
    expect(saved.INKBOX_API_KEY).toBe("ApiKey_new");
    expect(saved.INKBOX_IDENTITY).toBe("test-agent");
    expect(saved.INKBOX_ALLOW_ALL_USERS).toBe("true");
    expect(saved.INKBOX_VOICE_STACK).toBe("openai_realtime");
    expect(saved.INKBOX_REALTIME_ENABLED).toBe("true");
    expect(saved.INKBOX_REALTIME_API_KEY).toBe("sk-test");
    expect(saved.INKBOX_SIGNING_KEY).toBe("whsec_minted");
    expect(saved.INKBOX_PROJECT_DIR).toBe(tmp);
    expect(saved.INKBOX_GATEWAY_AGENT).toBe("inkbox-channel");
    expect(fs.statSync(d.envFilePath).mode & 0o777).toBe(0o600);

    expect(world.identity.update).toHaveBeenCalledWith({ imessageEnabled: true });
    expect(world.identity.provisionPhoneNumber).toHaveBeenCalled();
    expect(world.identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://test-agent.example/phone/media/ws",
      incomingCallWebhookUrl: "https://test-agent.example/webhook",
    });
    expect(d.installAutostartFn).toHaveBeenCalledWith(
      expect.objectContaining({ projectDirectory: tmp }),
    );
  });

  it("explains an identity-limit failure instead of calling it a wrong code", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    world.verify
      .mockRejectedValueOnce(new Error("HTTP 409: organization at capacity, cannot admit 1"))
      .mockResolvedValueOnce({ claimStatus: "claimed" });
    const { io, lines } = scriptedIO([
      false, // no key → signup
      "me@example.com",
      "test-agent",
      "123456", // fails on the capacity error
      "123456", // succeeds after (e.g. a slot was freed)
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
    expect(lines.join("\n")).toContain("identity limit, not a wrong code");
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

  it("reuses the initial admin credential to approve YOLO without asking twice", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    (world.identity.getHostedAgentConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorityMode: "contact_scoped",
      voice: "cedar",
      model: "voice-model",
      instructions: "Keep the call concise.",
    });
    (world.client.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.admin_scoped",
      organizationId: "org-1",
    });
    const { io, questions } = scriptedIO([
      true,
      "ApiKey_admin",
      0, // existing identity
      false, // iMessage
      0, // Inkbox Voice AI
      1, // YOLO
      false, // no signing key
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    fs.writeFileSync(
      d.envFilePath,
      [
        "INKBOX_REALTIME_API_KEY=sk-validated-existing",
        "INKBOX_REALTIME_MODEL=gpt-realtime-2",
        "INKBOX_REALTIME_VOICE=cedar",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect((world.identity as any).setHostedAgentAuthorityMode).toHaveBeenCalledWith({
      authorityMode: "yolo",
    });
    expect((world.identity as any).setHostedAgentConfig).not.toHaveBeenCalled();
    expect((world.identity as any).setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
    expect(savedEnv(d.envFilePath)).toMatchObject({
      INKBOX_VOICE_STACK: "inkbox_voice_ai",
      INKBOX_VOICE_AI_AUTHORITY_MODE: "yolo",
      INKBOX_REALTIME_API_KEY: "sk-validated-existing",
      INKBOX_REALTIME_MODEL: "gpt-realtime-2",
      INKBOX_REALTIME_VOICE: "cedar",
    });
    expect(questions).not.toContain(
      "  Paste an admin-scoped Inkbox API key for this authority change",
    );
  });

  it("uses the existing valid stack as the rerun selector default", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io, choiceDefaults } = scriptedIO([
      true, // reconfigure
      true,
      "ApiKey_agent",
      false,
      0, // accept Voice AI selection
      0, // contact-scoped
      false,
      true,
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(
      await runWizard(
        makeConfig({
          apiKey: "ApiKey_agent",
          identity: "test-agent",
          phoneVoiceStack: "inkbox_voice_ai",
        }),
        d,
      ),
    ).toBe(0);
    expect(choiceDefaults[0]).toBe(0);
  });

  it("does not claim a saved stack can override a fixed plugin option", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io, lines } = scriptedIO([
      true, // reconfigure
      true, // existing key
      "ApiKey_agent",
      false, // iMessage
      0, // Voice AI conflicts with the fixed TTS/STT option
      2, // choose the effective fixed option
      false, // no signing key
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(
      await runWizard(
        makeConfig({
          apiKey: "ApiKey_agent",
          identity: "test-agent",
          phoneVoiceStack: "inkbox_tts_stt",
          phoneVoiceStackOption: "inkbox_tts_stt",
        }),
        d,
      ),
    ).toBe(0);
    expect(lines.join("\n")).toContain(
      "plugin option phoneVoiceStack=inkbox_tts_stt overrides saved environment selections",
    );
    expect(savedEnv(d.envFilePath).INKBOX_VOICE_STACK).toBe("inkbox_tts_stt");
    expect(world.identity.setIncomingCallAction).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(
      "routing will be configured when the gateway starts and its public URL is known",
    );
  });

  it("keeps an agent key on the saved contact-scoped default without asking for admin", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io, questions } = scriptedIO([
      true,
      "ApiKey_agent",
      false,
      0, // Voice AI
      0, // saved contact-scoped authority
      false,
      true,
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect((world.identity as any).setHostedAgentAuthorityMode).not.toHaveBeenCalled();
    expect(questions).not.toContain(
      "  Paste an admin-scoped Inkbox API key for this authority change",
    );
    expect(savedEnv(d.envFilePath).INKBOX_VOICE_STACK).toBe("inkbox_voice_ai");
  });

  it("rejects agent-key YOLO elevation and loops back to the stack selector", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io, lines } = scriptedIO([
      true,
      "ApiKey_agent",
      false,
      0, // Voice AI
      1, // attempt YOLO
      "ApiKey_still_agent",
      2, // rejected: choose TTS/STT instead
      false,
      true,
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(lines.join("\n")).toContain("not an admin-scoped API key");
    expect((world.identity as any).setHostedAgentAuthorityMode).not.toHaveBeenCalled();
    expect(savedEnv(d.envFilePath).INKBOX_VOICE_STACK).toBe("inkbox_tts_stt");
  });

  it("rolls authority and routing back when Voice AI routing fails without persisting selection", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    (world.client.whoami as ReturnType<typeof vi.fn>).mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.admin_scoped",
      organizationId: "org-1",
    });
    (world.identity.getIncomingCallAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/phone/media/ws",
      incomingCallWebhookUrl: "https://old.example/webhook",
    });
    (world.identity.setIncomingCallAction as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("routing failed"))
      .mockResolvedValueOnce({});
    const { io, lines } = scriptedIO([
      true,
      "ApiKey_admin",
      0,
      false,
      0,
      1,
      2,
      false,
      true,
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(world.identity.setHostedAgentAuthorityMode).toHaveBeenNthCalledWith(1, {
      authorityMode: "yolo",
    });
    expect(world.identity.setHostedAgentAuthorityMode).toHaveBeenNthCalledWith(2, {
      authorityMode: "contact_scoped",
    });
    expect(world.identity.setIncomingCallAction).toHaveBeenNthCalledWith(2, {
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/phone/media/ws",
      incomingCallWebhookUrl: "https://old.example/webhook",
    });
    expect(savedEnv(d.envFilePath).INKBOX_VOICE_AI_AUTHORITY_MODE).toBeUndefined();
    expect(savedEnv(d.envFilePath).INKBOX_VOICE_STACK).toBe("inkbox_tts_stt");
    expect(lines.join("\n")).toContain("routing failed");
  });

  it("preserves validated Realtime credentials when selecting a non-Realtime stack", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io } = scriptedIO([
      true,
      "ApiKey_agent",
      false, // iMessage
      2, // Inkbox TTS/STT
      false, // no signing key
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    fs.writeFileSync(
      d.envFilePath,
      [
        "INKBOX_REALTIME_API_KEY=sk-validated-existing",
        "INKBOX_REALTIME_MODEL=gpt-realtime-2",
        "INKBOX_REALTIME_VOICE=cedar",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(savedEnv(d.envFilePath)).toMatchObject({
      INKBOX_VOICE_STACK: "inkbox_tts_stt",
      INKBOX_REALTIME_ENABLED: "false",
      INKBOX_REALTIME_API_KEY: "sk-validated-existing",
      INKBOX_REALTIME_MODEL: "gpt-realtime-2",
      INKBOX_REALTIME_VOICE: "cedar",
    });
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
    const { io, lines } = scriptedIO([
      true,
      "ApiKey_agent",
      false, // iMessage no
      true, // use realtime
      2, // validation failed → choose Inkbox TTS/STT
      false, // have signing key? no
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io, {
      env: { OPENAI_API_KEY: "sk-bad" },
      realtimeValidatorFn: vi.fn(async () => ({
        ok: false,
        detail: "HTTP 401 for sk-bad",
      })),
    });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(savedEnv(d.envFilePath)).toMatchObject({
      INKBOX_REALTIME_ENABLED: "false",
      INKBOX_VOICE_STACK: "inkbox_tts_stt",
    });
    expect(savedEnv(d.envFilePath).INKBOX_REALTIME_API_KEY).toBeUndefined();
    expect(world.identity.setIncomingCallAction).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("sk-bad");
  });

  it("lets the user replace a detected Realtime key after the handshake rejects it", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    const { io } = scriptedIO([
      true,
      "ApiKey_agent",
      false,
      1,
      1,
      "sk-good",
      false,
      true,
      "",
      false,
      false,
    ]);
    const validator = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, detail: "invalid_api_key" })
      .mockResolvedValueOnce({ ok: true, detail: "session updated" });
    const d = deps(world, io, {
      env: { OPENAI_API_KEY: "sk-stale" },
      realtimeValidatorFn: validator,
    });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(validator).toHaveBeenNthCalledWith(1, "sk-stale", "gpt-realtime-2");
    expect(validator).toHaveBeenNthCalledWith(2, "sk-good", "gpt-realtime-2");
    expect(savedEnv(d.envFilePath)).toMatchObject({
      INKBOX_VOICE_STACK: "openai_realtime",
      INKBOX_REALTIME_API_KEY: "sk-good",
      INKBOX_REALTIME_ENABLED: "true",
    });
  });

  it("reuses a newly validated admin identity after a failed Voice AI routing attempt", async () => {
    const world = fakeWorld({ phone: { id: "pn-1", number: "+15550001111", type: "local" } });
    (world.client.whoami as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        authType: "api_key",
        authSubtype: "api_key.agent_scoped.claimed",
        organizationId: "org-1",
      })
      .mockResolvedValueOnce({
        authType: "api_key",
        authSubtype: "api_key.admin_scoped",
        organizationId: "org-1",
      });
    (world.identity.setIncomingCallAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("routing failed"),
    );
    const { io, questions } = scriptedIO([
      true,
      "ApiKey_agent",
      false,
      0,
      1,
      "ApiKey_admin",
      0,
      1,
      false,
      true,
      "",
      false,
      false,
    ]);
    const d = deps(world, io);
    expect(await runWizard(makeConfig(), d)).toBe(0);
    expect(
      questions.filter(
        (question) =>
          question === "  Paste an admin-scoped Inkbox API key for this authority change",
      ),
    ).toHaveLength(1);
    expect(savedEnv(d.envFilePath)).toMatchObject({
      INKBOX_VOICE_STACK: "inkbox_voice_ai",
      INKBOX_VOICE_AI_AUTHORITY_MODE: "yolo",
    });
  });

  it("warns when a differing shell export will shadow the saved key", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO([
      false, // no key → signup
      "me@example.com",
      "test-agent",
      "123456",
      false, // iMessage no
      false, // provision no
      false, // have signing key? no
      true, // mint
      "", // project dir
      false, // no boot autostart
      false, // no background start
    ]);
    const d = deps(world, io, { env: { INKBOX_API_KEY: "ApiKey_stale" } });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("your shell exports INKBOX_API_KEY");
    expect(out).toContain("unset INKBOX_API_KEY");
    expect(savedEnv(d.envFilePath).INKBOX_API_KEY).toBe("ApiKey_new"); // file still gets the fresh key
  });

  it("points at the higher-precedence env file that shadows a saved var", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO([
      false, // no key → signup
      "me@example.com",
      "test-agent",
      "123456",
      false, // iMessage no
      false, // provision no
      false, // have signing key? no
      true, // mint
      "",
      false,
      false,
    ]);
    const d = deps(world, io, {
      env: { INKBOX_API_KEY: "ApiKey_stale" },
      envSources: new Map([["INKBOX_API_KEY", "/somewhere/.env"]]),
    });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("/somewhere/.env");
    expect(out).toContain("loads ahead of");
  });

  it("stays quiet when the old value lives in the wizard's own env file", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO([
      false, // no key → signup
      "me@example.com",
      "test-agent",
      "123456",
      false, // iMessage no
      false, // provision no
      false, // have signing key? no
      true, // mint
      "",
      false,
      false,
    ]);
    const envFilePath = path.join(tmp, ".env");
    const d = deps(world, io, {
      env: { INKBOX_API_KEY: "ApiKey_stale" },
      envSources: new Map([["INKBOX_API_KEY", envFilePath]]),
    });
    expect(await runWizard(makeConfig(), d)).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain("warning: your shell exports");
    expect(out).not.toContain("loads ahead of");
    expect(savedEnv(envFilePath).INKBOX_API_KEY).toBe("ApiKey_new");
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
  // --- keeping the gateway running -------------------------------------

  it("restarts a live gateway rather than no-opping on the background start", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true)); // no boot autostart, yes background
    const d = deps(world, io, { runningDaemonPidFn: vi.fn(() => 4242) });

    expect(await runWizard(makeConfig(), d)).toBe(0);

    // A live gateway is still on the old .env — starting it again would refuse.
    expect(d.restartDaemonFn).toHaveBeenCalled();
    expect(d.startDaemonFn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("pid 4242");
  });

  it("starts the gateway in the background when nothing is running", async () => {
    const world = fakeWorld();
    const { io } = scriptedIO(toAutostart(false, true));
    const d = deps(world, io);

    expect(await runWizard(makeConfig(), d)).toBe(0);

    expect(d.startDaemonFn).toHaveBeenCalled();
    expect(d.restartDaemonFn).not.toHaveBeenCalled();
  });

  it("restarts a live gateway when boot autostart could not be installed", async () => {
    const world = fakeWorld();
    const { io } = scriptedIO(toAutostart(true)); // boot autostart, which fails below
    const d = deps(world, io, {
      installAutostartFn: vi.fn(async () => false),
      runningDaemonPidFn: vi.fn(() => 99),
    });

    expect(await runWizard(makeConfig(), d)).toBe(0);

    expect(d.installAutostartFn).toHaveBeenCalled();
    expect(d.restartDaemonFn).toHaveBeenCalled();
    expect(d.startDaemonFn).not.toHaveBeenCalled();
  });

  it("starts nothing when both offers are declined", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, false));
    const d = deps(world, io);

    expect(await runWizard(makeConfig(), d)).toBe(0);

    expect(d.startDaemonFn).not.toHaveBeenCalled();
    expect(d.restartDaemonFn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("inkbox-opencode start");
  });
});

describe("closing banner", () => {
  it("names the identity and the health command when the gateway is live", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true));
    const d = deps(world, io);

    expect(await runWizard(makeConfig(), d)).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("Your OpenCode agent is set up and running on Inkbox.");
    expect(output).toContain("test-agent");
    expect(output).toContain("inkbox-opencode doctor");
    expect(output).not.toContain("Start it with:");
  });

  it("keeps the box square", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true));
    const d = deps(world, io);
    await runWizard(makeConfig(), d);

    const box = lines.filter((l) => l.startsWith("╭") || l.startsWith("│") || l.startsWith("╰"));
    expect(box.length).toBeGreaterThan(0);
    expect(new Set(box.map((l) => l.length)).size).toBe(1);
  });

  it("falls back to the to-do list when nothing is listening", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, false));
    const d = deps(world, io);

    expect(await runWizard(makeConfig(), d)).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("Setup complete.");
    expect(output).toContain("inkbox-opencode start");
    expect(output).not.toContain("is set up and running on Inkbox");
  });

  it("does not claim success when the daemon refuses to start", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true));
    const d = deps(world, io, { startDaemonFn: vi.fn(async () => 1) });

    expect(await runWizard(makeConfig(), d)).toBe(0);

    expect(lines.join("\n")).not.toContain("is set up and running on Inkbox");
  });
});

describe("start confirmation", () => {
  it("does not print the banner when the gateway dies right after starting", async () => {
    // startDaemon returns 0 as soon as it has spawned, so a gateway that fails
    // to bind still reports success — the banner must not follow it.
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true));
    const d = deps(world, io, { runningDaemonPidFn: vi.fn(() => undefined) });

    expect(await runWizard(makeConfig(), d)).toBe(0);

    const output = lines.join("\n");
    expect(output).toContain("exited right after starting");
    expect(output).toContain("gateway.log");
    expect(output).not.toContain("is set up and running on Inkbox");
  });

  it("keeps polling until the deadline before declaring it up", async () => {
    const world = fakeWorld();
    const { io, lines } = scriptedIO(toAutostart(false, true));
    let calls = 0;
    const d = deps(world, io, {
      // undefined for the pre-start check, then alive for every confirm poll.
      runningDaemonPidFn: vi.fn(() => (calls++ === 0 ? undefined : 4242)),
      confirmTimeoutMs: 1_000,
      sleep: async () => {},
    });

    expect(await runWizard(makeConfig(), d)).toBe(0);

    expect(lines.join("\n")).toContain("is set up and running on Inkbox");
    expect(calls).toBeGreaterThan(2); // polled, did not probe once
  });
});
