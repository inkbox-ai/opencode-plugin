import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("@inkbox/sdk", () => ({
  Inkbox: function Inkbox() {
    return world.client;
  },
}));

vi.mock("../../src/cli/daemon.js", () => ({
  runningDaemonPid: vi.fn(() => 123),
  restartDaemon: vi.fn(async () => 0),
  startDaemon: vi.fn(async () => 0),
}));

import { bootstrap } from "../../src/cli/bootstrap.js";

let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-opencode-bootstrap-"));
  process.env.INKBOX_OPENCODE_ENV_FILE = path.join(temp, ".env");
  delete process.env.INKBOX_IDENTITY;
  delete process.env.INKBOX_SIGNING_KEY;
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  delete process.env.INKBOX_OPENCODE_ENV_FILE;
  delete process.env.INKBOX_API_KEY;
  delete process.env.INKBOX_IDENTITY;
  delete process.env.INKBOX_SIGNING_KEY;
  vi.clearAllMocks();
});

function fakeWorld(signingConfigured = false) {
  const identity = {
    id: "identity-1",
    agentHandle: "helper",
    mailbox: { emailAddress: "helper@example.com" },
    phoneNumber: { number: "+15551234567" },
    tunnel: { publicHost: "helper.example.com" },
    imessageEnabled: false,
    getHostedAgentConfig: vi.fn(async () => ({
      voice: "cedar",
      model: "voice",
      instructions: undefined,
      authorityMode: "contact_scoped",
    })),
    setHostedAgentConfig: vi.fn(async () => ({})),
    getIncomingCallAction: vi.fn(async () => ({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old",
    })),
    setIncomingCallAction: vi.fn(async () => ({})),
    getSigningKeyStatus: vi.fn(async () => ({ configured: signingConfigured })),
    createSigningKey: vi.fn(async () => ({ signingKey: "signing-secret" })),
  };
  world.client = {
    whoami: vi.fn(async () => ({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
    })),
    listIdentities: vi.fn(async () => [{ agentHandle: "helper" }]),
    getIdentity: vi.fn(async () => identity),
    imessages: { getTriageNumber: vi.fn() },
  };
  return identity;
}

describe("bootstrap", () => {
  it("configures the exact identity, Voice AI, signing, and the gateway", async () => {
    const identity = fakeWorld();
    const result = await bootstrap({
      identity: "@helper",
      apiKey: "agent-secret",
      projectDir: temp,
      voiceAi: true,
      rotateSigningKey: true,
      startGateway: true,
    });
    expect(result.status).toBe("configured");
    expect(result.gatewayRunning).toBe(true);
    expect(identity.setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
    const saved = fs.readFileSync(path.join(temp, ".env"), "utf8");
    expect(saved).toContain("INKBOX_API_KEY=agent-secret");
    expect(saved).toContain("INKBOX_SIGNING_KEY=signing-secret");
    expect(saved).toContain(`INKBOX_PROJECT_DIR=${temp}`);
  });

  it("requires explicit rotation when the remote signing key is not local", async () => {
    const identity = fakeWorld(true);
    const result = await bootstrap({ identity: "helper", apiKey: "agent-secret" });
    expect(result.status).toBe("requires_human");
    expect(result.humanActions?.[0]).toContain("--rotate-signing-key");
    expect(identity.createSigningKey).not.toHaveBeenCalled();
  });
});
