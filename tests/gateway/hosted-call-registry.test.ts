import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateHostedSmsCapture,
  assertHostedCallTarget,
  assertHostedToolAllowed,
  beginHostedSmsAttempt,
  classifyHostedSmsError,
  clearHostedSmsCapture,
  getHostedCall,
  HOSTED_REGISTRY_DIRECTORY_MODE,
  HOSTED_REGISTRY_FILE_MODE,
  saveHostedCall,
  settleHostedSmsAttempt,
} from "../../src/gateway/hosted-call-registry.js";

let dir: string;

function event(): CallEndedWebhookPayload {
  return {
    id: "evt-1",
    event_type: "call.ended",
    timestamp: "2026-08-01T00:00:00Z",
    data: {
      call: {
        id: "call-1",
        mode: "hosted_agent",
        direction: "inbound",
        status: "completed",
        remote_phone_number: "+14155550123",
      },
      outcome: "completed",
      contacts: [],
      agent_identities: [],
      transcript: { entries: [] },
      transcript_url: null,
      post_call_action_items: [],
    },
  } as unknown as CallEndedWebhookPayload;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-hosted-"));
  process.env.INKBOX_OPENCODE_HOME = dir;
  saveHostedCall({
    identityId: "ident-1",
    callId: "call-1",
    eventId: "evt-1",
    state: "running",
    event: event(),
  });
  activateHostedSmsCapture({
    identityId: "ident-1",
    callId: "call-1",
    sessionID: "session-1",
    phase: "initial",
    expectedTarget: "+14155550123",
  });
});

afterEach(() => {
  delete process.env.INKBOX_OPENCODE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hosted SMS durable guard", () => {
  it("fails closed on corrupt or non-object journal contents", () => {
    const file = path.join(dir, "hosted-call-completions.json");
    fs.writeFileSync(file, "{not-json", { mode: 0o600 });
    expect(() => getHostedCall("ident-1", "call-1")).toThrow();
    fs.writeFileSync(file, "[]\n", { mode: 0o600 });
    expect(() => getHostedCall("ident-1", "call-1")).toThrow("must contain a JSON object");
    fs.writeFileSync(file, '{"bad":42}\n', { mode: 0o600 });
    expect(() => getHostedCall("ident-1", "call-1")).toThrow("contains an invalid entry");
  });

  it("fails closed when the journal path cannot be read as a file", () => {
    const file = path.join(dir, "hosted-call-completions.json");
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => getHostedCall("ident-1", "call-1")).toThrow();
  });

  it("keeps its directory, journal, temp, and lock private", () => {
    fs.chmodSync(dir, 0o755);
    clearHostedSmsCapture("ident-1", "call-1");
    expect(HOSTED_REGISTRY_DIRECTORY_MODE).toBe(0o700);
    expect(HOSTED_REGISTRY_FILE_MODE).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(HOSTED_REGISTRY_DIRECTORY_MODE);
    expect(fs.statSync(path.join(dir, "hosted-call-completions.json")).mode & 0o777).toBe(
      HOSTED_REGISTRY_FILE_MODE,
    );
  });

  it("fails closed immediately while another process owns the journal lock", () => {
    const lock = path.join(dir, "hosted-call-completions.json.lock");
    fs.writeFileSync(lock, "99999\n");
    const started = Date.now();
    expect(() => clearHostedSmsCapture("ident-1", "call-1")).toThrow("hosted-call journal is busy");
    expect(Date.now() - started).toBeLessThan(100);
    fs.unlinkSync(lock);
  });

  it("recovers a stale journal lock before mutating", () => {
    const lock = path.join(dir, "hosted-call-completions.json.lock");
    fs.writeFileSync(lock, "99999\n");
    const stale = new Date(Date.now() - 61_000);
    fs.utimesSync(lock, stale, stale);
    expect(() => clearHostedSmsCapture("ident-1", "call-1")).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("journals the exact target before it can be settled successful", () => {
    const guard = beginHostedSmsAttempt({
      sessionID: "session-1",
      messageId: "message-1",
      target: "+14155550123",
      hasConversationId: false,
    });
    expect(guard).toBeDefined();
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0]).toMatchObject({
      target: "+14155550123",
      targetMatches: true,
      state: "pending",
      messageId: "message-1",
    });
    if (!guard) throw new Error("expected hosted SMS guard");
    settleHostedSmsAttempt(guard, "success");
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0].state).toBe("success");
  });

  it("blocks a contact-derived wrong number before provider work", () => {
    expect(() =>
      beginHostedSmsAttempt({
        sessionID: "session-1",
        target: "+15550009999",
        hasConversationId: false,
      }),
    ).toThrow("non-authoritative");
    expect(getHostedCall("ident-1", "call-1")?.smsAttempts[0]).toMatchObject({
      targetMatches: false,
      state: "failed",
    });
  });

  it("blocks conversation addressing and a second provider attempt", () => {
    expect(() =>
      beginHostedSmsAttempt({
        sessionID: "session-1",
        hasConversationId: true,
      }),
    ).toThrow("non-authoritative");
    expect(() =>
      beginHostedSmsAttempt({
        sessionID: "session-1",
        target: "+14155550123",
        hasConversationId: false,
      }),
    ).toThrow("second SMS attempt");
  });

  it("does not apply one call's settlement guard to an unrelated session", () => {
    const lock = path.join(dir, "hosted-call-completions.json.lock");
    fs.writeFileSync(lock, "another-owner\n");
    expect(
      beginHostedSmsAttempt({
        sessionID: "unrelated-session",
        target: "+14155550123",
        hasConversationId: false,
      }),
    ).toBeUndefined();
    fs.unlinkSync(lock);
    clearHostedSmsCapture("ident-1", "call-1");
    expect(
      beginHostedSmsAttempt({
        sessionID: "ordinary-session",
        target: "+15550000000",
        hasConversationId: false,
      }),
    ).toBeUndefined();
  });

  it("blocks a matching session while its recent capture owner is gone", () => {
    saveHostedCall({
      identityId: "ident-1",
      callId: "call-1",
      eventId: "evt-1",
      state: "running",
      event: event(),
      active: {
        sessionID: "session-1",
        phase: "initial",
        expectedTarget: "+14155550123",
        ownerPid: Number.MAX_SAFE_INTEGER,
        startedAt: Date.now(),
      },
    });
    expect(() =>
      beginHostedSmsAttempt({
        sessionID: "session-1",
        target: "+14155550123",
        hasConversationId: false,
      }),
    ).toThrow("gateway owner is unavailable");
  });

  it("expires an abandoned capture marker instead of blocking a session forever", () => {
    saveHostedCall({
      identityId: "ident-1",
      callId: "call-1",
      eventId: "evt-1",
      state: "running",
      event: event(),
      active: {
        sessionID: "session-1",
        phase: "initial",
        expectedTarget: "+14155550123",
        ownerPid: Number.MAX_SAFE_INTEGER,
        startedAt: Date.now() - 2 * 60 * 60 * 1000,
      },
    });
    expect(
      beginHostedSmsAttempt({
        sessionID: "session-1",
        target: "+14155550123",
        hasConversationId: false,
      }),
    ).toBeUndefined();
  });

  it("classifies a server 422 as a correctable pre-send rejection", () => {
    expect(classifyHostedSmsError("Validation error (422): text format rejected")).toBe(
      "pre_send_validation",
    );
  });

  it.each([
    ["request timeout", "Inkbox API error (408): request timed out"],
    ["rate limit", "Inkbox API error (429): carrier rate limit"],
    ["upstream outage", "Inkbox API error (503): carrier unavailable"],
    ["unknown duplicate commit", "duplicate request with unknown commit status"],
  ])("classifies a commit-ambiguous %s as terminal settlement", (_label, message) => {
    expect(classifyHostedSmsError(message)).toBe("ambiguous_provider_failure");
  });

  it.each([
    ["missing consent", "Recipient is not opted in for SMS"],
    ["revoked consent", "Recipient opted out of SMS"],
    ["invalid carrier destination", "Carrier says invalid phone number"],
  ])("classifies %s as a terminal recipient failure", (_label, message) => {
    expect(classifyHostedSmsError(message)).toBe("recipient_terminal");
  });

  it("allows a hosted callback only to the authoritative current caller", () => {
    expect(assertHostedCallTarget("session-1", "+14155550123")).toBe(true);
    expect(() => assertHostedCallTarget("session-1", "+15550009999")).toThrow("non-authoritative");
  });

  it("allows only the SMS tool during the mandatory correction turn", () => {
    clearHostedSmsCapture("ident-1", "call-1");
    activateHostedSmsCapture({
      identityId: "ident-1",
      callId: "call-1",
      sessionID: "session-1",
      phase: "correction",
      expectedTarget: "+14155550123",
    });
    expect(() => assertHostedToolAllowed("session-1", "inkbox_send_sms")).not.toThrow();
    expect(() => assertHostedToolAllowed("session-1", "inkbox_send_email")).toThrow(
      "permits only inkbox_send_sms",
    );
    expect(() => assertHostedToolAllowed("ordinary-session", "inkbox_send_email")).not.toThrow();
  });
});
