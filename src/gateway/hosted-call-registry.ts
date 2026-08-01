import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { gatewayHome } from "./state.js";

export type HostedSmsErrorKind =
  | "pre_send_validation"
  | "content_rejected"
  | "recipient_terminal"
  | "ambiguous_provider_failure";

export interface HostedSmsAttempt {
  phase: "initial" | "correction";
  id: string;
  messageId?: string;
  target?: string;
  targetMatches: boolean;
  state: "pending" | "success" | "failed";
  errorKind?: HostedSmsErrorKind;
}

export interface HostedCallEntry {
  identityId: string;
  callId: string;
  eventId: string;
  state: "queued" | "running" | "completed" | "failed";
  outcome?: string;
  retryable?: boolean;
  event: CallEndedWebhookPayload;
  active?: {
    sessionID: string;
    phase: "initial" | "correction";
    expectedTarget: string;
    ownerPid: number;
    startedAt: number;
  };
  smsAttempts: HostedSmsAttempt[];
  updatedAt: number;
}

type Registry = Record<string, HostedCallEntry>;

function registryPath(): string {
  return path.join(gatewayHome(), "hosted-call-completions.json");
}

function read(): Registry {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function acquireRegistryLock(lock: string): number {
  // Registry mutations are synchronous and very short. Fail closed instead
  // of blocking OpenCode's event loop behind another gateway process; the
  // webhook/provider retry can safely replay against the durable journal.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: number | undefined;
    try {
      handle = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${process.pid}\n`);
      } catch (error) {
        fs.closeSync(handle);
        try {
          fs.unlinkSync(lock);
        } catch {
          // Preserve the original initialization error.
        }
        throw error;
      }
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs <= 60_000) {
          throw new Error("The hosted-call journal is busy; retry this event.");
        }
        fs.unlinkSync(lock);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }
    }
  }
  throw new Error("Could not acquire the hosted-call journal lock.");
}

function withRegistryMutation<T>(change: (registry: Registry) => T): T {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const handle = acquireRegistryLock(lock);
  try {
    const registry = read();
    const result = change(registry);
    write(registry);
    return result;
  } finally {
    fs.closeSync(handle);
    try {
      fs.unlinkSync(lock);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function write(registry: Registry): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bounded = Object.fromEntries(
    Object.entries(registry)
      .filter(([, entry]) => Date.now() - entry.updatedAt < 30 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 1_000),
  );
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(bounded, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function replayEvent(event: CallEndedWebhookPayload): CallEndedWebhookPayload {
  const source = event as any;
  const call = source.data?.call ?? {};
  return {
    id: bounded(source.id, 256) ?? `call:${bounded(call.id, 256) ?? "unknown"}`,
    event_type: "call.ended",
    timestamp: bounded(source.timestamp, 128) ?? new Date().toISOString(),
    data: {
      call: {
        id: bounded(call.id, 256) ?? "",
        mode: call.mode,
      },
      contacts: [],
      post_call_action_items: [],
    },
  } as unknown as CallEndedWebhookPayload;
}

function receiptEvent(event: CallEndedWebhookPayload): CallEndedWebhookPayload {
  return replayEvent(event);
}

export function hostedCallKey(identityId: string, callId: string): string {
  return `${identityId}:${callId}`;
}

export function getHostedCall(identityId: string, callId: string): HostedCallEntry | undefined {
  return read()[hostedCallKey(identityId, callId)];
}

export function listRecoverableHostedCalls(identityId: string): HostedCallEntry[] {
  return Object.values(read()).filter(
    (entry) =>
      entry.identityId === identityId &&
      entry.state !== "completed" &&
      !(entry.state === "failed" && !entry.retryable),
  );
}

export function saveHostedCall(
  entry: Omit<HostedCallEntry, "updatedAt" | "smsAttempts"> & { smsAttempts?: HostedSmsAttempt[] },
): void {
  withRegistryMutation((registry) => {
    const key = hostedCallKey(entry.identityId, entry.callId);
    const existing = registry[key];
    const replayable = entry.state === "queued" || entry.state === "running" || entry.retryable;
    registry[key] = {
      ...entry,
      event: replayable ? replayEvent(entry.event) : receiptEvent(entry.event),
      smsAttempts: entry.smsAttempts ?? existing?.smsAttempts ?? [],
      updatedAt: Date.now(),
    };
  });
}

export function activateHostedSmsCapture(params: {
  identityId: string;
  callId: string;
  sessionID: string;
  phase: "initial" | "correction";
  expectedTarget: string;
}): void {
  withRegistryMutation((registry) => {
    const key = hostedCallKey(params.identityId, params.callId);
    const entry = registry[key];
    if (!entry) throw new Error("Hosted call registry entry is missing.");
    entry.active = {
      sessionID: params.sessionID,
      phase: params.phase,
      expectedTarget: params.expectedTarget,
      ownerPid: process.pid,
      startedAt: Date.now(),
    };
    entry.updatedAt = Date.now();
  });
}

export function clearHostedSmsCapture(identityId: string, callId: string): void {
  withRegistryMutation((registry) => {
    const entry = registry[hostedCallKey(identityId, callId)];
    if (!entry) return;
    delete entry.active;
    entry.updatedAt = Date.now();
  });
}

export interface HostedSmsGuard {
  identityId: string;
  callId: string;
  attemptId: string;
  expectedTarget: string;
}

function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function activeHostedEntry(registry: Registry, sessionID: string): HostedCallEntry | undefined {
  const matches = Object.values(registry).filter(
    (entry) =>
      entry.state === "running" &&
      entry.active?.sessionID === sessionID &&
      !activeCaptureIsExpired(entry),
  );
  if (matches.length > 1) {
    throw new Error("Blocked side effect because the hosted-call capture is ambiguous.");
  }
  const match = matches[0];
  if (match && !activeCaptureOwnerIsLive(match)) {
    throw new Error("Blocked hosted-call side effect because its gateway owner is unavailable.");
  }
  return match;
}

function activeCaptureIsExpired(entry: HostedCallEntry): boolean {
  const active = entry.active;
  return (
    !active ||
    !Number.isInteger(active.ownerPid) ||
    !Number.isFinite(active.startedAt) ||
    Date.now() - active.startedAt > 60 * 60 * 1000
  );
}

function activeCaptureOwnerIsLive(entry: HostedCallEntry): boolean {
  const ownerPid = entry.active?.ownerPid;
  if (!ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function assertHostedCallTarget(sessionID: string, target: string): boolean {
  const match = activeHostedEntry(read(), sessionID);
  if (!match?.active) return false;
  if (target !== match.active.expectedTarget) {
    throw new Error("Blocked hosted callback to a non-authoritative call target.");
  }
  return true;
}

export function assertHostedToolAllowed(sessionID: string, toolName: string): void {
  const registry = read();
  const matches = Object.values(registry).filter(
    (entry) =>
      entry.state === "running" &&
      entry.active?.sessionID === sessionID &&
      !activeCaptureIsExpired(entry),
  );
  if (matches.length > 1) {
    throw new Error("Blocked tool call because the hosted-call capture is ambiguous.");
  }
  if (matches[0] && !activeCaptureOwnerIsLive(matches[0])) {
    throw new Error("Blocked hosted-call tool because its gateway owner is unavailable.");
  }
  if (matches[0]?.active?.phase === "correction" && toolName !== "inkbox_send_sms") {
    throw new Error("The hosted-call correction turn permits only inkbox_send_sms.");
  }
}

export function beginHostedSmsAttempt(params: {
  sessionID: string;
  messageId?: string;
  target?: string;
  hasConversationId: boolean;
}): HostedSmsGuard | undefined {
  // Ordinary sends never need the cross-process mutation lock. Hosted
  // capture is activated before its prompt starts, so no match means this
  // session is outside settlement.
  if (!activeHostedEntry(read(), params.sessionID)?.active) return undefined;
  const result = withRegistryMutation<{ guard?: HostedSmsGuard; error?: string }>((registry) => {
    const match = activeHostedEntry(registry, params.sessionID);
    if (!match?.active) return {};
    const phaseAttempts = match.smsAttempts.filter(
      (attempt) => attempt.phase === match.active?.phase,
    );
    if (phaseAttempts.length > 0) {
      throw new Error("Blocked a second SMS attempt during hosted-call reconciliation.");
    }
    const missingTarget = !params.hasConversationId && params.target === undefined;
    const targetMatches =
      missingTarget ||
      (!params.hasConversationId &&
        params.target !== undefined &&
        phoneDigits(params.target) === phoneDigits(match.active.expectedTarget));
    const attempt: HostedSmsAttempt = {
      phase: match.active.phase,
      id: randomUUID(),
      messageId: bounded(params.messageId, 256),
      target: params.target,
      targetMatches,
      state: missingTarget ? "failed" : targetMatches ? "pending" : "failed",
      ...(missingTarget
        ? { errorKind: "pre_send_validation" as const }
        : !targetMatches
          ? { errorKind: "recipient_terminal" as const }
          : {}),
    };
    match.smsAttempts.push(attempt);
    match.updatedAt = Date.now();
    if (missingTarget) {
      return { error: "Hosted post-call SMS requires the explicit authoritative target." };
    }
    if (!targetMatches) {
      return { error: "Blocked hosted SMS to a non-authoritative call target." };
    }
    return {
      guard: {
        identityId: match.identityId,
        callId: match.callId,
        attemptId: attempt.id,
        expectedTarget: match.active.expectedTarget,
      },
    };
  });
  if (result.error) throw new Error(result.error);
  return result.guard;
}

export function settleHostedSmsAttempt(
  guard: HostedSmsGuard,
  state: "success" | "failed",
  errorKind?: HostedSmsErrorKind,
): void {
  withRegistryMutation((registry) => {
    const entry = registry[hostedCallKey(guard.identityId, guard.callId)];
    const attempt = entry?.smsAttempts.find((item) => item.id === guard.attemptId);
    if (!entry || !attempt || attempt.state !== "pending") {
      throw new Error("Hosted SMS pending journal entry is missing.");
    }
    attempt.state = state;
    attempt.errorKind = errorKind;
    entry.updatedAt = Date.now();
  });
}

export function classifyHostedSmsError(error: unknown): HostedSmsErrorKind {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /specify exactly one of|must include at least one|maximum is \d+|too long|validation error \(422\)|http 422/.test(
      message,
    )
  ) {
    return "pre_send_validation";
  }
  if (/content[_ -]?(?:policy|rejected|violation)|markdown|emoji|profanity/.test(message)) {
    return "content_rejected";
  }
  if (
    /not opted in|opted out|invalid (?:phone|number)|unreachable|blocked|not on the outbound allowlist/.test(
      message,
    )
  ) {
    return "recipient_terminal";
  }
  return "ambiguous_provider_failure";
}
