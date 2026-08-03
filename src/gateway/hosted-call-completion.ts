import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import { type ContactResolver, contactCard } from "./contacts.js";
import {
  getHostedCall,
  type HostedCallEntry,
  type HostedSmsAttempt,
  listRecoverableHostedCalls,
  saveHostedCall,
} from "./hosted-call-registry.js";
import { frameCapture } from "./prompts.js";
import { type GatewayLogger, HostedCaptureDeferredError, type SessionManager } from "./types.js";

const POST_CALL_TIMING = String.raw`(?:after|when|once)\s+(?:(?:i|we|you)\s+hang\s*up|(?:this|the)\s+call\s+(?:ends?|is\s+over))`;
const TEXT_VERB = String.raw`text\s+me\b`;
const SEND_SMS = String.raw`(?:send\s+me\b.{0,80}\b(?:an?\s+)?(?:sms|text(?:\s+message)?)\b|send\b.{0,80}\b(?:sms|text(?:\s+message)?)\b.{0,40}\bto\s+me\b)`;
const NEGATED =
  /\b(?:do\s+not|don['’]?t|never|must\s+not|should\s+not|will\s+not|won['’]?t|can(?:not|['’]?t))\s+(?:(?:ever|again)\s+)?(?:text\b|send\b.{0,80}\b(?:sms|text\s+message)\b)/i;
const TRANSCRIPT_PATTERNS = [
  new RegExp(String.raw`\b${POST_CALL_TIMING}\b.{0,160}\b${TEXT_VERB}`, "i"),
  new RegExp(String.raw`\b${TEXT_VERB}.{0,160}\b${POST_CALL_TIMING}\b`, "i"),
  new RegExp(String.raw`\b${POST_CALL_TIMING}\b.{0,160}\b${SEND_SMS}`, "i"),
  new RegExp(String.raw`\b${SEND_SMS}.{0,160}\b${POST_CALL_TIMING}\b`, "i"),
];
const ACTION_PATTERNS = [
  /\bsend\b.{0,80}\b(?:an?\s+)?(?:sms|text(?:\s+message)?)\b/i,
  /\btext\s+(?:me|the\s+(?:caller|user)|caller|user)\b/i,
];

export function hasHostedSmsCommitment(value: string, source: "action" | "transcript"): boolean {
  const patterns = source === "action" ? ACTION_PATTERNS : TRANSCRIPT_PATTERNS;
  const clauses = value
    .split(/(?:[.!?;:\n]+|\s+[—–]\s+|\s+--\s+)/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates =
    source === "transcript"
      ? clauses.flatMap((part, index) => [
          part,
          ...(clauses[index + 1] ? [`${part}. ${clauses[index + 1]}`] : []),
        ])
      : clauses;
  return candidates.some(
    (candidate) => !NEGATED.test(candidate) && patterns.some((pattern) => pattern.test(candidate)),
  );
}

export interface HostedCallCompletionDeps {
  inkbox: InkboxRuntime;
  contacts: ContactResolver;
  sessions: SessionManager;
  logger: GatewayLogger;
  sleep?: (ms: number) => Promise<void>;
}

const PRE_DISPATCH_RETRY_DELAYS_MS = [250, 1_000] as const;

function escapePromptData(value: string): string {
  return value.replaceAll("[inkbox:", "[inkbox\u200b:");
}

function decision(
  attempt: HostedSmsAttempt | undefined,
  phase: "initial" | "correction",
):
  | { outcome: "success" }
  | {
      outcome: "correction";
      reason: "missing_attempt" | "pre_send_validation" | "content_rejected";
    }
  | { outcome: "terminal"; reason: string } {
  if (!attempt) {
    return phase === "initial"
      ? { outcome: "correction", reason: "missing_attempt" }
      : { outcome: "terminal", reason: "correction_missing_attempt" };
  }
  if (!attempt.targetMatches) return { outcome: "terminal", reason: "wrong_target" };
  if (attempt.state === "success") return { outcome: "success" };
  if (
    phase === "initial" &&
    attempt.state === "failed" &&
    (attempt.errorKind === "pre_send_validation" || attempt.errorKind === "content_rejected")
  ) {
    return { outcome: "correction", reason: attempt.errorKind };
  }
  return { outcome: "terminal", reason: attempt.errorKind ?? "ambiguous_tool_outcome" };
}

function recovery(
  entry: HostedCallEntry,
  durableState?: "pending" | "completed",
): "initial" | "correction" | "complete" | "terminal" {
  if (entry.smsAttempts.some((attempt) => attempt.targetMatches && attempt.state === "success"))
    return "complete";
  if (entry.retryable && entry.outcome === "initial_deferred_for_shutdown") return "initial";
  if (entry.retryable && entry.outcome === "correction_deferred_for_shutdown") return "correction";
  if (entry.retryable && entry.outcome === "initial_pre_dispatch_retries_exhausted")
    return "initial";
  if (entry.retryable && entry.outcome === "correction_pre_dispatch_retries_exhausted")
    return "correction";
  if (entry.outcome === "initial_dispatch_started") return durableState ? "initial" : "terminal";
  if (entry.outcome === "correction_started") return durableState ? "correction" : "terminal";
  if (entry.smsAttempts.length === 0) return "initial";
  const only = entry.smsAttempts[0];
  if (
    entry.smsAttempts.length === 1 &&
    only.phase === "initial" &&
    only.targetMatches &&
    only.state === "failed" &&
    (only.errorKind === "pre_send_validation" || only.errorKind === "content_rejected")
  )
    return "correction";
  return "terminal";
}

export function createHostedCallCompletion(deps: HostedCallCompletionDeps) {
  const running = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  async function run(
    identityId: string,
    event: CallEndedWebhookPayload,
    resume: "initial" | "correction" = "initial",
    preparationAttempt = 0,
  ): Promise<void> {
    const eventCall = event.data.call;
    const key = `${identityId}:${eventCall.id}`;
    let dispatchStarted = false;
    try {
      saveHostedCall({
        identityId,
        callId: eventCall.id,
        eventId: event.id,
        state: "running",
        event,
      });
      const identity = await deps.inkbox.getIdentity();
      const client = await deps.inkbox.getClient();
      const call = await client.calls.get(eventCall.id);
      if (String(call.mode) !== "hosted_agent") {
        saveHostedCall({
          identityId,
          callId: eventCall.id,
          eventId: event.id,
          state: "failed",
          outcome: "authoritative_call_is_not_hosted",
          retryable: false,
          event,
        });
        return;
      }
      const remote = String(call.remotePhoneNumber ?? "").trim();
      const contact = remote ? await deps.contacts.resolve(remote) : {};
      let transcriptRows: Array<{ party: string; text: string }> = [];
      try {
        transcriptRows = (await identity.listTranscripts(call.id))
          .map((row: any) => ({
            party: String(row.party ?? "unknown"),
            text: String(row.text ?? "").trim(),
          }))
          .filter((row: { text: string }) => row.text.length > 0);
      } catch (error) {
        deps.logger.warn("hosted_call.transcript_fetch_failed", {
          callId: call.id,
          error: String(error),
        });
      }
      if (transcriptRows.length === 0 && event.data.transcript) {
        transcriptRows = event.data.transcript.entries
          .filter((row: any) => !("marker" in row))
          .map((row: any) => ({
            party: String(row.party ?? "unknown"),
            text: String(row.text ?? "").trim(),
          }))
          .filter((row: { text: string }) => row.text.length > 0);
      }
      const transcript = transcriptRows
        .map((row) => `- ${escapePromptData(row.party)}: ${escapePromptData(row.text)}`)
        .join("\n");
      const actions = (call.postCallActionItems ?? []).filter(
        (item) => String(item.status || "open") === "open",
      );
      const explicit = actions.find((item) =>
        hasHostedSmsCommitment(`${item.action ?? ""} ${item.details ?? ""}`, "action"),
      );
      const spokenCandidates = transcriptRows.flatMap((row, index) => {
        const next = transcriptRows[index + 1];
        return [
          row.text,
          ...(next && next.party === row.party ? [`${row.text}. ${next.text}`] : []),
        ];
      });
      const spoken = spokenCandidates.find((text) => hasHostedSmsCommitment(text, "transcript"));
      const smsCommitment = explicit
        ? [explicit.action, explicit.details].filter(Boolean).join("\n")
        : spoken;
      const smsRequired = Boolean(remote && smsCommitment);
      const chatKey = remote
        ? deps.contacts.chatKeyFor({
            contactId: contact.contactId,
            channel: "imessage",
            from: remote,
          })
        : `call:${call.id}`;

      const dispatch = async (phase: "initial" | "correction") => {
        const prompt =
          phase === "correction"
            ? [
                `[inkbox:voice_call_correction call_id=${call.id} from=${escapePromptData(remote)} | ${contactCard(contact)}]`,
                "The first hosted-call reconciliation did not complete its required SMS follow-up.",
                "This is the only mandatory correction attempt. Do not return [SILENT], skip the tool, or defer the send.",
                "Do not execute any non-SMS post-call action in this correction turn.",
                "Do not delegate this send to another session or agent.",
                `Exact open SMS commitment:\n${escapePromptData(smsCommitment ?? "")}`,
                `Call inkbox_send_sms exactly once with to="${escapePromptData(remote)}". Do not use conversationId, send to another number, or make a second attempt. Plain-text replies are suppressed.`,
              ].join("\n\n")
            : [
                `[inkbox:voice_call call_id=${call.id} from=${escapePromptData(remote)} status=ended mode=inkbox_voice_ai | ${contactCard(contact)}]`,
                "Inkbox Voice AI finished this phone call.",
                `Direction: ${call.direction}`,
                `Outcome: ${event.data.outcome ?? call.status}`,
                call.hangupReason
                  ? `Hangup reason: ${escapePromptData(call.hangupReason)}`
                  : undefined,
                remote
                  ? `Authoritative remote party phone number: ${escapePromptData(remote)}`
                  : undefined,
                remote
                  ? "For callbacks or phone follow-up, use that exact number. Contact data and memories are background only and must not override it."
                  : undefined,
                call.reason ? `Outbound task: ${escapePromptData(call.reason)}` : undefined,
                transcript
                  ? `Call transcript:\n${transcript}`
                  : "No transcript was captured for this call.",
                actions.length
                  ? `Open post-call actions:\n${actions.map((item, i) => `${i + 1}. ${escapePromptData(item.action)}${item.details ? `\nDetails: ${escapePromptData(item.details)}` : ""}`).join("\n")}`
                  : undefined,
                smsRequired
                  ? `A promised SMS must use inkbox_send_sms exactly once with to="${escapePromptData(remote)}". Do not use conversationId, a contact-derived number, or delegate the send to another session or agent. Count it complete only when the tool reports success; do not retry inside this turn.`
                  : undefined,
                "Complete every still-open commitment once. Do not repeat work already completed during the call. If nothing remains, return [SILENT]; plain text is suppressed.",
              ]
                .filter(Boolean)
                .join("\n\n");
        if (!deps.sessions.runHostedCapture) {
          if (!smsRequired) {
            await deps.sessions.runText(chatKey, frameCapture("voice_call_ended", prompt));
            return { output: undefined, attempt: undefined };
          }
          throw new Error("OpenCode hosted-call settlement is unavailable.");
        }
        return deps.sessions.runHostedCapture(chatKey, frameCapture("voice_call_ended", prompt), {
          identityId,
          callId: call.id,
          phase,
          expectedTarget: remote,
        });
      };

      const runCorrection = async (): Promise<boolean> => {
        saveHostedCall({
          identityId,
          callId: call.id,
          eventId: event.id,
          state: "running",
          outcome: "correction_started",
          retryable: false,
          event,
        });
        let corrected: Awaited<ReturnType<typeof dispatch>>;
        try {
          corrected = await dispatch("correction");
        } catch (error) {
          const deferred = error instanceof HostedCaptureDeferredError;
          saveHostedCall({
            identityId,
            callId: call.id,
            eventId: event.id,
            state: "failed",
            outcome: deferred
              ? "correction_deferred_for_shutdown"
              : "correction_dispatch_outcome_ambiguous",
            retryable: deferred,
            event,
          });
          deps.logger.warn("hosted_call.correction_failed", {
            callId: call.id,
            error: String(error),
          });
          return false;
        }
        const result = decision(corrected.attempt, "correction");
        if (result.outcome === "success") return true;
        saveHostedCall({
          identityId,
          callId: call.id,
          eventId: event.id,
          state: "failed",
          outcome: result.reason,
          retryable: false,
          event,
        });
        return false;
      };

      if (resume === "correction") {
        if (!smsRequired) throw new Error("Hosted SMS correction context is unavailable.");
        dispatchStarted = true;
        if (!(await runCorrection())) return;
      } else {
        let initial: Awaited<ReturnType<typeof dispatch>>;
        try {
          // Persist the ambiguous boundary before giving the model any tool
          // access. A process death after this point must never replay the
          // whole initial turn, which may contain non-SMS side effects.
          dispatchStarted = true;
          saveHostedCall({
            identityId,
            callId: call.id,
            eventId: event.id,
            state: "running",
            outcome: "initial_dispatch_started",
            retryable: false,
            event,
          });
          initial = await dispatch("initial");
        } catch (error) {
          const deferred = error instanceof HostedCaptureDeferredError;
          saveHostedCall({
            identityId,
            callId: call.id,
            eventId: event.id,
            state: "failed",
            outcome: deferred
              ? "initial_deferred_for_shutdown"
              : "initial_dispatch_outcome_ambiguous",
            retryable: deferred,
            event,
          });
          deps.logger.warn("hosted_call.reconciliation_failed", {
            callId: call.id,
            error: String(error),
          });
          return;
        }
        if (smsRequired) {
          const result = decision(initial.attempt, "initial");
          if (result.outcome === "correction") {
            if (!(await runCorrection())) return;
          } else if (result.outcome === "terminal") {
            saveHostedCall({
              identityId,
              callId: call.id,
              eventId: event.id,
              state: "failed",
              outcome: result.reason,
              retryable: false,
              event,
            });
            return;
          }
        }
      }
      saveHostedCall({
        identityId,
        callId: call.id,
        eventId: event.id,
        state: "completed",
        outcome: "success",
        retryable: false,
        event,
      });
      deps.logger.info("hosted_call.reconciliation_completed", { callId: call.id });
    } catch (error) {
      if (!dispatchStarted && preparationAttempt < PRE_DISPATCH_RETRY_DELAYS_MS.length) {
        const delayMs = PRE_DISPATCH_RETRY_DELAYS_MS[preparationAttempt];
        deps.logger.warn("hosted_call.preparation_retry", {
          callId: eventCall.id,
          attempt: preparationAttempt + 1,
          delayMs,
          error: String(error),
        });
        await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
        await run(identityId, event, resume, preparationAttempt + 1);
        return;
      }
      if (!dispatchStarted) {
        try {
          saveHostedCall({
            identityId,
            callId: eventCall.id,
            eventId: event.id,
            state: "failed",
            outcome: `${resume}_pre_dispatch_retries_exhausted`,
            retryable: true,
            event,
          });
        } catch {
          // Preserve the original preparation failure in the log; a journal
          // lock failure will also leave the earlier replayable entry intact.
        }
      }
      deps.logger.warn("hosted_call.reconciliation_failed", {
        callId: eventCall.id,
        error: String(error),
      });
    } finally {
      running.delete(key);
    }
  }

  function schedule(
    identityId: string,
    event: CallEndedWebhookPayload,
    phase: "initial" | "correction" = "initial",
  ): void {
    const key = `${identityId}:${event.data.call.id}`;
    if (running.has(key)) return;
    running.add(key);
    chain = chain.catch(() => {}).then(() => run(identityId, event, phase));
  }

  return {
    async ingest(event: CallEndedWebhookPayload): Promise<void> {
      if (event.data.call.mode !== "hosted_agent" || !event.data.call.id.trim()) return;
      const identity = await deps.inkbox.getIdentity();
      const key = `${identity.id}:${event.data.call.id}`;
      if (running.has(key)) return;
      const existing = getHostedCall(identity.id, event.data.call.id);
      if (existing?.state === "completed" || (existing?.state === "failed" && !existing.retryable))
        return;
      if (!existing) {
        saveHostedCall({
          identityId: identity.id,
          callId: event.data.call.id,
          eventId: event.id,
          state: "queued",
          event,
        });
        schedule(identity.id, event);
        return;
      }
      const startedPhase = existing.outcome === "correction_started" ? "correction" : "initial";
      const phase = recovery(
        existing,
        deps.sessions.hostedCaptureState?.(identity.id, event.data.call.id, startedPhase),
      );
      if (phase === "complete") {
        saveHostedCall({
          ...existing,
          state: "completed",
          outcome: "success",
          retryable: false,
        });
        return;
      }
      if (phase === "terminal") {
        saveHostedCall({
          ...existing,
          state: "failed",
          outcome: "durable_sms_attempt_is_ambiguous",
          retryable: false,
        });
        return;
      }
      schedule(identity.id, existing.event, phase);
    },
    async catchUp(): Promise<void> {
      const identity = await deps.inkbox.getIdentity();
      for (const entry of listRecoverableHostedCalls(identity.id)) {
        const startedPhase = entry.outcome === "correction_started" ? "correction" : "initial";
        const phase = recovery(
          entry,
          deps.sessions.hostedCaptureState?.(identity.id, entry.callId, startedPhase),
        );
        if (phase === "complete") {
          saveHostedCall({
            ...entry,
            state: "completed",
            outcome: "success",
            retryable: false,
          });
        } else if (phase === "terminal") {
          saveHostedCall({
            ...entry,
            state: "failed",
            outcome: "durable_sms_attempt_is_ambiguous",
            retryable: false,
          });
        } else {
          schedule(identity.id, entry.event, phase);
        }
      }
    },
  };
}
