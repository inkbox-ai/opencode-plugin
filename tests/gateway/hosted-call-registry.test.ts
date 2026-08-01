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
  });
});
