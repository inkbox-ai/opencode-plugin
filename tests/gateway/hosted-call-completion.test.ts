import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostedCallCompletion,
  hasHostedSmsCommitment,
} from "../../src/gateway/hosted-call-completion.js";
import {
  getHostedCall,
  type HostedSmsAttempt,
  saveHostedCall,
} from "../../src/gateway/hosted-call-registry.js";
import { HostedCaptureDeferredError } from "../../src/gateway/types.js";

let dir: string;

function event(overrides: Record<string, unknown> = {}): CallEndedWebhookPayload {
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
        local_phone_number: "+14155550124",
        ...overrides,
      },
      outcome: "completed",
      contacts: [],
      agent_identities: [],
      transcript: { entries: [] },
      transcript_url: null,
      post_call_action_items: [
        { id: "a-1", action: "Text me the phonetic marker after this call ends", status: "open" },
      ],
    },
  } as unknown as CallEndedWebhookPayload;
}

async function waitForState(state: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (getHostedCall("ident-1", "call-1")?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`hosted call did not reach ${state}`);
}

function deps(attempts: Array<HostedSmsAttempt | undefined>) {
  const runHostedCapture = vi.fn(async () => ({ attempt: attempts.shift() }));
  const callsGet = vi.fn(async () => authoritativeCall);
  const authoritativeCall = {
    id: "call-1",
    mode: "hosted_agent",
    direction: "inbound",
    status: "completed",
    remotePhoneNumber: "+14155550123",
    reason: null,
    hangupReason: "local",
    postCallActionItems: [
      { id: "a-1", action: "Text me the phonetic marker after this call ends", status: "open" },
    ],
  };
  return {
    inkbox: {
      getIdentity: vi.fn(async () => ({
        id: "ident-1",
        listTranscripts: vi.fn(async () => [
          { party: "remote", text: "Please text me the phonetic marker when this call ends." },
        ]),
      })),
      getClient: vi.fn(async () => ({ calls: { get: callsGet } })),
    },
    contacts: {
      resolve: vi.fn(async () => ({
        contactId: "contact-wrong",
        contactName: "Wrong Contact",
        contactPhones: ["+15550009999"],
      })),
      chatKeyFor: vi.fn(
        (input: { contactId?: string; from: string }) => input.contactId ?? input.from,
      ),
    },
    sessions: { runHostedCapture, runText: vi.fn(async () => undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sleep: vi.fn(async () => {}),
    runHostedCapture,
    callsGet,
    authoritativeCall,
  } as any;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-hosted-completion-"));
  process.env.INKBOX_OPENCODE_HOME = dir;
});

afterEach(() => {
  delete process.env.INKBOX_OPENCODE_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hosted call completion", () => {
  it("rejects a corrupt durable journal before dispatching any reconciliation", async () => {
    fs.writeFileSync(path.join(dir, "hosted-call-completions.json"), "{broken", { mode: 0o600 });
    const d = deps([]);
    await expect(createHostedCallCompletion(d).ingest(event())).rejects.toThrow();
    expect(d.runHostedCapture).not.toHaveBeenCalled();
  });

  it("does not turn a caller's third-party texting plan into an agent commitment", () => {
    expect(
      hasHostedSmsCommitment(
        "When this call ends, I will text my wife the release address.",
        "transcript",
      ),
    ).toBe(false);
    expect(
      hasHostedSmsCommitment("After we hang up, text me the release address.", "transcript"),
    ).toBe(true);
  });

  it("uses the call record's authoritative remote number despite conflicting contact data", async () => {
    const d = deps([
      {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("completed");
    const [chatKey, prompt, capture] = d.runHostedCapture.mock.calls[0];
    expect(chatKey).toContain("contact-wrong");
    expect(prompt).toContain("from=+14155550123");
    expect(prompt).toContain('to="+14155550123"');
    expect(capture.expectedTarget).toBe("+14155550123");
    expect(prompt).not.toContain('to="+15550009999"');
    expect(d.contacts.chatKeyFor).toHaveBeenCalledWith({
      contactId: "contact-wrong",
      channel: "imessage",
      from: "+14155550123",
    });
  });

  it("retries transient preparation failures in-process before dispatch", async () => {
    const d = deps([
      {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    d.inkbox.getClient
      .mockRejectedValueOnce(new Error("temporary API outage"))
      .mockRejectedValueOnce(new Error("temporary API outage"));
    await createHostedCallCompletion(d).ingest(event());
    await waitForState("completed");
    expect(d.inkbox.getClient).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenNthCalledWith(1, 250);
    expect(d.sleep).toHaveBeenNthCalledWith(2, 1_000);
    expect(d.runHostedCapture).toHaveBeenCalledOnce();
  });

  it("acknowledges a duplicate webhook without disturbing the in-flight settlement", async () => {
    const d = deps([]);
    let finish: (value: unknown) => void = () => {};
    d.runHostedCapture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("running");
    await service.ingest(event());
    expect(getHostedCall("ident-1", "call-1")?.state).toBe("running");
    finish({
      attempt: {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    });
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledOnce();
  });

  it("issues one mandatory correction when the initial turn makes no attempt", async () => {
    const d = deps([
      undefined,
      {
        phase: "correction",
        id: "attempt-2",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    await createHostedCallCompletion(d).ingest(event());
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledTimes(2);
    const correction = d.runHostedCapture.mock.calls[1][1];
    expect(correction).toContain("only mandatory correction attempt");
    expect(correction).toContain("Do not return [SILENT]");
    expect(correction).toContain("Do not execute any non-SMS");
  });

  it("does not retry an ambiguous provider outcome", async () => {
    const d = deps([
      {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "failed",
        errorKind: "ambiguous_provider_failure",
      },
    ]);
    await createHostedCallCompletion(d).ingest(event());
    await waitForState("failed");
    expect(d.runHostedCapture).toHaveBeenCalledTimes(1);
    expect(getHostedCall("ident-1", "call-1")?.retryable).toBe(false);
  });

  it("recognizes an after-call SMS promise split across adjacent caller segments", async () => {
    const d = deps([
      {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    d.inkbox.getIdentity.mockResolvedValue({
      id: "ident-1",
      listTranscripts: vi.fn(async () => [
        { party: "remote", text: "After we hang up" },
        { party: "remote", text: "send me an SMS with the marker" },
      ]),
    });
    d.authoritativeCall.postCallActionItems = [];
    await createHostedCallCompletion(d).ingest(event());
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledOnce();
    expect(d.runHostedCapture.mock.calls[0][1]).toContain("After we hang up");
  });

  it("does not create hosted reconciliation work for a local audio call", async () => {
    const d = deps([]);
    await createHostedCallCompletion(d).ingest(event({ mode: "client_websocket" }));
    expect(d.runHostedCapture).not.toHaveBeenCalled();
    expect(getHostedCall("ident-1", "call-1")).toBeUndefined();
  });

  it("rejects a stale hosted webhook when the authoritative call is local audio", async () => {
    const d = deps([]);
    d.authoritativeCall.mode = "client_websocket";
    await createHostedCallCompletion(d).ingest(event());
    await waitForState("failed");
    expect(d.runHostedCapture).not.toHaveBeenCalled();
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      outcome: "authoritative_call_is_not_hosted",
      retryable: false,
    });
  });

  it("does not persist the raw call transcript in the durable replay journal", async () => {
    const d = deps([
      {
        phase: "initial",
        id: "attempt-1",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    const withSecretTranscript = event() as any;
    withSecretTranscript.data.transcript.entries = [
      { party: "remote", text: "raw transcript secret must not be journaled" },
    ];
    withSecretTranscript.data.call.reason = "private call reason must not be journaled";
    withSecretTranscript.data.post_call_action_items = [
      { action: "private action details must not be journaled", status: "open" },
    ];
    await createHostedCallCompletion(d).ingest(withSecretTranscript);
    await waitForState("completed");
    const journal = fs.readFileSync(path.join(dir, "hosted-call-completions.json"), "utf8");
    expect(journal).not.toContain("raw transcript secret must not be journaled");
    expect(journal).not.toContain("private call reason must not be journaled");
    expect(journal).not.toContain("private action details must not be journaled");
  });

  it("defers a correction interrupted by shutdown and completes it after catch-up", async () => {
    const d = deps([undefined]);
    d.runHostedCapture
      .mockResolvedValueOnce({ attempt: undefined })
      .mockRejectedValueOnce(new HostedCaptureDeferredError())
      .mockResolvedValueOnce({
        attempt: {
          phase: "correction",
          id: "attempt-2",
          target: "+14155550123",
          targetMatches: true,
          state: "success",
        },
      });
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("failed");
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      outcome: "correction_deferred_for_shutdown",
      retryable: true,
    });
    await service.catchUp();
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledTimes(3);
  });

  it("resumes correction after its preparation retries were exhausted", async () => {
    saveHostedCall({
      identityId: "ident-1",
      callId: "call-1",
      eventId: "evt-1",
      state: "failed",
      outcome: "correction_pre_dispatch_retries_exhausted",
      retryable: true,
      event: event(),
    });
    const d = deps([
      {
        phase: "correction",
        id: "attempt-2",
        target: "+14155550123",
        targetMatches: true,
        state: "success",
      },
    ]);
    await createHostedCallCompletion(d).catchUp();
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledOnce();
    expect(d.runHostedCapture.mock.calls[0][2].phase).toBe("correction");
    expect(d.runHostedCapture.mock.calls[0][1]).toContain("only mandatory correction attempt");
  });

  it("does not repeat a correction whose dispatch outcome became ambiguous", async () => {
    const d = deps([]);
    d.runHostedCapture
      .mockResolvedValueOnce({ attempt: undefined })
      .mockRejectedValueOnce(new Error("session transport closed during prompt"));
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("failed");
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      outcome: "correction_dispatch_outcome_ambiguous",
      retryable: false,
    });
    await service.catchUp();
    expect(d.runHostedCapture).toHaveBeenCalledTimes(2);
  });

  it("restarts an initial turn only when shutdown deferred it before execution", async () => {
    const d = deps([]);
    d.runHostedCapture
      .mockRejectedValueOnce(new HostedCaptureDeferredError())
      .mockResolvedValueOnce({
        attempt: {
          phase: "initial",
          id: "attempt-1",
          target: "+14155550123",
          targetMatches: true,
          state: "success",
        },
      });
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("failed");
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      outcome: "initial_deferred_for_shutdown",
      retryable: true,
    });
    await service.catchUp();
    await waitForState("completed");
    expect(d.runHostedCapture).toHaveBeenCalledTimes(2);
  });

  it("does not replay an initial turn whose execution outcome is ambiguous", async () => {
    const d = deps([]);
    d.runHostedCapture.mockRejectedValueOnce(new Error("session transport closed during prompt"));
    const service = createHostedCallCompletion(d);
    await service.ingest(event());
    await waitForState("failed");
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      outcome: "initial_dispatch_outcome_ambiguous",
      retryable: false,
    });
    await service.catchUp();
    expect(d.runHostedCapture).toHaveBeenCalledOnce();
  });

  it("settles completed after restart when the successful provider result was already journaled", async () => {
    saveHostedCall({
      identityId: "ident-1",
      callId: "call-1",
      eventId: "evt-1",
      state: "running",
      outcome: "initial_dispatch_started",
      retryable: false,
      event: event(),
      smsAttempts: [
        {
          phase: "initial",
          id: "attempt-1",
          target: "+14155550123",
          targetMatches: true,
          state: "success",
        },
      ],
    });
    const d = deps([]);
    await createHostedCallCompletion(d).catchUp();
    expect(getHostedCall("ident-1", "call-1")).toMatchObject({
      state: "completed",
      outcome: "success",
      retryable: false,
    });
    expect(d.runHostedCapture).not.toHaveBeenCalled();
  });

  it.each([
    ["queued before initial dispatch", { state: "queued" }, "initial", "completed", "success"],
    [
      "retryable initial preparation failure",
      { state: "failed", outcome: "initial_pre_dispatch_retries_exhausted", retryable: true },
      "initial",
      "completed",
      "success",
    ],
    [
      "correctable initial provider result",
      {
        state: "running",
        smsAttempts: [
          {
            phase: "initial",
            id: "attempt-1",
            target: "+14155550123",
            targetMatches: true,
            state: "failed",
            errorKind: "content_rejected",
          },
        ],
      },
      "correction",
      "completed",
      "success",
    ],
    [
      "retryable correction preparation failure",
      { state: "failed", outcome: "correction_pre_dispatch_retries_exhausted", retryable: true },
      "correction",
      "completed",
      "success",
    ],
    [
      "initial dispatch ambiguous boundary",
      { state: "running", outcome: "initial_dispatch_started" },
      undefined,
      "failed",
      "durable_sms_attempt_is_ambiguous",
    ],
    [
      "correction dispatch ambiguous boundary",
      { state: "running", outcome: "correction_started" },
      undefined,
      "failed",
      "durable_sms_attempt_is_ambiguous",
    ],
    [
      "pending provider attempt",
      {
        state: "running",
        smsAttempts: [
          {
            phase: "initial",
            id: "attempt-1",
            target: "+14155550123",
            targetMatches: true,
            state: "pending",
          },
        ],
      },
      undefined,
      "failed",
      "durable_sms_attempt_is_ambiguous",
    ],
    [
      "successful provider result",
      {
        state: "running",
        smsAttempts: [
          {
            phase: "initial",
            id: "attempt-1",
            target: "+14155550123",
            targetMatches: true,
            state: "success",
          },
        ],
      },
      undefined,
      "completed",
      "success",
    ],
  ] as const)(
    "recovers safely after restart at the %s transition",
    async (_label, snapshot, expectedPhase, expectedState, expectedOutcome) => {
      const smsAttempts: HostedSmsAttempt[] | undefined =
        "smsAttempts" in snapshot
          ? snapshot.smsAttempts.map((attempt) => ({ ...attempt }))
          : undefined;
      saveHostedCall({
        identityId: "ident-1",
        callId: "call-1",
        eventId: "evt-1",
        retryable: false,
        event: event(),
        ...snapshot,
        smsAttempts,
      });
      const d = deps(
        expectedPhase
          ? [
              {
                phase: expectedPhase,
                id: "attempt-after-restart",
                target: "+14155550123",
                targetMatches: true,
                state: "success",
              },
            ]
          : [],
      );
      await createHostedCallCompletion(d).catchUp();
      await waitForState(expectedState);
      expect(getHostedCall("ident-1", "call-1")).toMatchObject({
        state: expectedState,
        outcome: expectedOutcome,
        retryable: false,
      });
      if (expectedPhase) {
        expect(d.runHostedCapture).toHaveBeenCalledOnce();
        expect(d.runHostedCapture.mock.calls[0][2].phase).toBe(expectedPhase);
      } else {
        expect(d.runHostedCapture).not.toHaveBeenCalled();
      }
    },
  );
});
