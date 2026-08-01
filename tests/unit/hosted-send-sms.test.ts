import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateHostedSmsCapture,
  getHostedCall,
  saveHostedCall,
} from "../../src/gateway/hosted-call-registry.js";
import { sendSmsTools } from "../../src/tools/send-sms.js";
import type { ToolDeps } from "../../src/tools/types.js";

let dir: string;
let sendText: ReturnType<typeof vi.fn>;

function makeDeps(allowedRecipients: string[] = []): ToolDeps {
  sendText = vi.fn(async () => ({ id: "sms-1", deliveryStatus: "queued" }));
  return {
    runtime: {
      getIdentity: vi.fn(async () => ({ sendText })),
      getClient: vi.fn(async () => ({})),
    } as any,
    config: {
      apiKey: "k",
      identity: "agent",
      phoneVoiceStack: "inkbox_voice_ai",
      vaultKeyEnvVar: "INKBOX_VAULT_KEY",
      tools: { enable: [], disable: [] },
      outbound: { allowedRecipients, approval: "ask", askTimeoutMs: 1 },
      gateway: {} as any,
    },
    vault: {} as any,
  };
}

function setupCapture(): void {
  const event = {
    id: "evt-1",
    event_type: "call.ended",
    timestamp: "2026-08-01T00:00:00Z",
    data: {
      call: { id: "call-1", mode: "hosted_agent", remote_phone_number: "+14155550123" },
      contacts: [],
      agent_identities: [],
      transcript: { entries: [] },
      transcript_url: null,
      post_call_action_items: [],
    },
  } as unknown as CallEndedWebhookPayload;
  saveHostedCall({
    identityId: "ident-1",
    callId: "call-1",
    eventId: "evt-1",
    state: "running",
    event,
  });
  activateHostedSmsCapture({
    identityId: "ident-1",
    callId: "call-1",
    sessionID: "session-1",
    phase: "initial",
    expectedTarget: "+14155550123",
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-hosted-send-"));
  process.env.INKBOX_OPENCODE_HOME = dir;
  setupCapture();
});

afterEach(() => {
  delete process.env.INKBOX_OPENCODE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hosted send SMS boundary", () => {
  it("skips interactive approval only for the exact call target and settles success", async () => {
    const [tool] = sendSmsTools(makeDeps());
    const ctx = {
      sessionID: "session-1",
      messageID: "message-1",
      ask: vi.fn(async () => {
        throw new Error("approval should not run");
      }),
      abort: new AbortController().signal,
    } as any;
    await tool.definition.execute({ to: "+14155550123", text: "bravo maple" }, ctx);
    expect(sendText).toHaveBeenCalledOnce();
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0].state).toBe("success");
  });

  it("does not rewrite a provider-accepted SMS as failed when success journaling fails", async () => {
    const [tool] = sendSmsTools(makeDeps());
    sendText.mockImplementationOnce(async () => {
      fs.writeFileSync(path.join(dir, "hosted-call-completions.json"), "{broken", { mode: 0o600 });
      return { id: "sms-accepted", deliveryStatus: "queued" };
    });
    await expect(
      tool.definition.execute({ to: "+14155550123", text: "bravo maple" }, {
        sessionID: "session-1",
        messageID: "message-1",
        ask: vi.fn(),
        abort: new AbortController().signal,
      } as any),
    ).rejects.toThrow(/provider accepted.*do not retry/);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("canonicalizes a formatting-only target variant to the authoritative E.164 number", async () => {
    const [tool] = sendSmsTools(makeDeps());
    await tool.definition.execute({ to: "+1 (415) 555-0123", text: "bravo maple" }, {
      sessionID: "session-1",
      messageID: "message-1",
      ask: vi.fn(),
      abort: new AbortController().signal,
    } as any);
    expect(sendText).toHaveBeenCalledWith({ text: "bravo maple", to: "+14155550123" });
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0]).toMatchObject({
      target: "+1 (415) 555-0123",
      targetMatches: true,
      state: "success",
    });
  });

  it("blocks a wrong target before loading the identity or calling the provider", async () => {
    const deps = makeDeps();
    const [tool] = sendSmsTools(deps);
    await expect(
      tool.definition.execute({ to: "+15550009999", text: "bravo maple" }, {
        sessionID: "session-1",
        messageID: "m",
        ask: vi.fn(),
        abort: new AbortController().signal,
      } as any),
    ).rejects.toThrow("non-authoritative");
    expect(deps.runtime.getIdentity).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("journals a missing target as a safe pre-send failure eligible for correction", async () => {
    const deps = makeDeps();
    const [tool] = sendSmsTools(deps);
    await expect(
      tool.definition.execute({ text: "bravo maple" }, {
        sessionID: "session-1",
        messageID: "message-missing-target",
        ask: vi.fn(),
        abort: new AbortController().signal,
      } as any),
    ).rejects.toThrow("requires the explicit authoritative target");
    expect(deps.runtime.getIdentity).not.toHaveBeenCalled();
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0]).toMatchObject({
      targetMatches: true,
      state: "failed",
      errorKind: "pre_send_validation",
    });
  });

  it("enforces a configured outbound allowlist without opening an interactive prompt", async () => {
    const deps = makeDeps(["+15550009999"]);
    const [tool] = sendSmsTools(deps);
    await expect(
      tool.definition.execute({ to: "+14155550123", text: "bravo maple" }, {
        sessionID: "session-1",
        messageID: "m",
        ask: vi.fn(),
        abort: new AbortController().signal,
      } as any),
    ).rejects.toThrow("not on the outbound allowlist");
    expect(deps.runtime.getIdentity).not.toHaveBeenCalled();
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0]).toMatchObject({
      state: "failed",
      errorKind: "recipient_terminal",
    });
  });
});
