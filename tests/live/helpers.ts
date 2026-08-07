// Shared plumbing for the live suite: a REMOTE Inkbox identity probes the
// agent-under-test (AUT) over real channels and polls for the reply. Every
// test is skipped unless both API keys are present, so `npm test` and CI
// unit runs never touch the network.
import { randomBytes } from "node:crypto";
import { Inkbox } from "@inkbox/sdk";

// Truthy fallbacks, not ??: an unset GitHub `vars.*` arrives as an empty
// string (not undefined), which nullish-coalescing would wrongly keep.
export const BASE_URL = process.env.INKBOX_BASE_URL || "https://inkbox.ai";
export const AUT_KEY = process.env.AUT_INKBOX_API_KEY;
export const REMOTE_KEY = process.env.REMOTE_INKBOX_API_KEY;
export const LIVE = Boolean(AUT_KEY && REMOTE_KEY);
// "real" legs exercise a real model; "mock" legs prove the pipe for free.
export const REAL_MODEL = process.env.LIVE_REAL_MODEL === "1";
export const TIMEOUT_MS = Number(process.env.LIVE_REPLY_TIMEOUT_S || "150") * 1000;
export const POLL_MS = 5000;

// Strings that mean the agent replied with a failure instead of an answer.
export const ERROR_MARKERS = [
  "non-retryable error",
  "missing authentication",
  "http 401",
  "http 403",
  "traceback",
  "session.prompt failed",
];

export function client(apiKey: string): Inkbox {
  return new Inkbox({ apiKey, baseUrl: BASE_URL });
}

export async function retrySafeRead<T>(
  read: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch {
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * delayMs));
    }
  }
  throw new Error(`idempotent live API read failed after ${attempts} attempts`);
}

export async function listCalls(c: Inkbox, limit = 30) {
  return retrySafeRead(() => c.calls.list({ limit }));
}

export function nonce(): string {
  return `smoke-${randomBytes(4).toString("hex")}`;
}

export async function mailboxOf(c: Inkbox): Promise<string> {
  const boxes = await c.mailboxes.list();
  if (boxes.length === 0) throw new Error("identity has no mailbox");
  return boxes[0].emailAddress;
}

export async function phoneOf(c: Inkbox): Promise<{ id: string; number: string }> {
  const numbers = await c.phoneNumbers.list();
  if (numbers.length === 0) throw new Error("identity has no phone number");
  return { id: numbers[0].id, number: numbers[0].number };
}

// Poll until fn returns a value, else throw with the given label.
export async function pollUntil<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = await fn();
    if (out !== undefined) return out;
    if (Date.now() > deadline) throw new Error(`${label}: nothing within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function assertNotErrorReply(body: string, label: string): void {
  const lower = body.toLowerCase();
  const bad = ERROR_MARKERS.filter((m) => lower.includes(m));
  if (bad.length > 0) {
    throw new Error(`${label}: reply is an error, not an answer (${bad.join(", ")})`);
  }
}

// Collect inbound email ids currently visible in the remote mailbox.
export async function inboundEmailIds(c: Inkbox, mailbox: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const m of c.messages.list(mailbox, { direction: "inbound" as never, pageSize: 30 })) {
    ids.add((m as { id: string }).id);
    if (ids.size >= 30) break;
  }
  return ids;
}

// Find a NEW inbound email (not in `before`) from the given sender.
export async function newInboundEmailFrom(
  c: Inkbox,
  mailbox: string,
  fromAddress: string,
  before: Set<string>,
  accept?: (message: { id: string; subject?: string; snippet?: string }) => boolean,
): Promise<{ id: string; subject?: string; snippet?: string } | undefined> {
  const want = fromAddress.toLowerCase();
  for await (const m of c.messages.list(mailbox, { direction: "inbound" as never, pageSize: 30 })) {
    const msg = m as { id: string; fromAddress?: string; subject?: string; snippet?: string };
    if (before.has(msg.id)) continue;
    if ((msg.fromAddress ?? "").toLowerCase() !== want) continue;
    if (!accept || accept(msg)) return msg;
  }
  return undefined;
}

const digits = (s: string) => s.replace(/\D/g, "");

// Inbound texts from the AUT's number, newest slice of the conversation.
export async function inboundTextsFrom(
  c: Inkbox,
  phoneNumberId: string,
  autNumber: string,
): Promise<Array<{ id: string; text: string }>> {
  const tail = digits(autNumber).slice(-10);
  const out: Array<{ id: string; text: string }> = [];
  for (const m of await c.texts.list(phoneNumberId, { limit: 30 })) {
    const msg = m as unknown as {
      id: string;
      direction?: string;
      remotePhoneNumber?: string;
      text?: string;
    };
    if ((msg.direction ?? "").toLowerCase() !== "inbound") continue;
    if (digits(msg.remotePhoneNumber ?? "").slice(-10) !== tail) continue;
    out.push({ id: msg.id, text: msg.text ?? "" });
  }
  return out;
}

// A call's transcript split by ownership-relative party.
export async function callSegments(
  c: Inkbox,
  callId: string,
): Promise<{ remote: string[]; local: string[] }> {
  const segs = (await c.calls.transcripts(callId)) as Array<{ party?: string; text?: string }>;
  const pick = (party: string) =>
    segs
      .filter((s) => (s.party ?? "").toLowerCase() === party && (s.text ?? "").trim() !== "")
      .map((s) => (s.text ?? "").trim());
  return { remote: pick("remote"), local: pick("local") };
}

// Read from the AUT owner: remote is the caller and local is the agent.
export async function waitTwoWayCall(
  aut: Inkbox,
  callId: string,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  const terminalFailureStatuses = new Set(["canceled", "failed"]);
  // A call can end normally and still never carry a conversation — detection
  // hanging up on the driver ends it `completed`, hangupReason=voicemail.
  // Transcript rows can still land during teardown, so allow a short grace
  // period rather than polling a finished call for the full timeout.
  const endedStatuses = new Set(["completed"]);
  const endedGraceMs = Number(process.env.LIVE_VOICE_ENDED_GRACE_S || "15") * 1000;
  let endedAt: number | undefined;
  return pollUntil(
    "two-way call transcript",
    async () => {
      const { remote, local } = await callSegments(aut, callId).catch(() => ({
        remote: [],
        local: [],
      }));
      if (remote.length > 0 && local.length > 0) return local.join(" | ");

      const call = await aut.calls.get(callId).catch(() => undefined);
      const status = (call?.status ?? "").toLowerCase();
      const detail = () =>
        JSON.stringify({
          status: call?.status,
          hangupReason: call?.hangupReason,
          startedAt: call?.startedAt,
          endedAt: call?.endedAt,
        });
      if (terminalFailureStatuses.has(status)) {
        throw new Error(`two-way call ended before both parties spoke: ${detail()}`);
      }
      if (endedStatuses.has(status)) {
        if (endedAt === undefined) endedAt = Date.now();
        else if (Date.now() - endedAt > endedGraceMs) {
          throw new Error(`two-way call ended without both parties speaking: ${detail()}`);
        }
      }
      return undefined;
    },
    timeoutMs,
  );
}

// Read from the driver owner: local is the scripted driver speech.
export async function waitDriverLocalSpeech(
  driver: Inkbox,
  callId: string,
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  let completedAt: number | undefined;
  const completedGraceMs = 15_000;
  return pollUntil(
    "driver-local call transcript",
    async () => {
      const { local } = await callSegments(driver, callId).catch(() => ({
        remote: [],
        local: [],
      }));
      if (local.length > 0) return local.join(" | ");
      const call = await driver.calls.get(callId).catch(() => undefined);
      const status = String(call?.status ?? "").toLowerCase();
      if (["canceled", "failed"].includes(status)) {
        throw new Error("driver call ended before local speech was persisted");
      }
      if (status === "completed") {
        completedAt ??= Date.now();
        if (Date.now() - completedAt > completedGraceMs) {
          throw new Error("driver call completed without persisted local speech");
        }
      }
      return undefined;
    },
    timeoutMs,
  );
}

// Settle, send an SMS to the AUT, and return the first new matching reply.
// Settling first folds any trailing reply to a previous question into
// `before`, so it can't be mis-matched as this question's answer.
export async function askOverSms(
  remote: Inkbox,
  remotePhoneId: string,
  autNumber: string,
  text: string,
  accept: (body: string) => boolean,
): Promise<string> {
  let before = new Set((await inboundTextsFrom(remote, remotePhoneId, autNumber)).map((m) => m.id));
  const quietDeadline = Date.now() + 2 * POLL_MS;
  while (Date.now() < quietDeadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const now = new Set(
      (await inboundTextsFrom(remote, remotePhoneId, autNumber)).map((m) => m.id),
    );
    if (now.size === before.size && [...now].every((id) => before.has(id))) break;
    before = now;
  }

  await remote.texts.send(remotePhoneId, { to: autNumber, text });

  const reply = await pollUntil("current correlated SMS reply", async () => {
    const inbound = await inboundTextsFrom(remote, remotePhoneId, autNumber);
    return inbound.find((m) => !before.has(m.id) && accept(m.text));
  });
  assertNotErrorReply(reply.text, "sms");
  return reply.text;
}
