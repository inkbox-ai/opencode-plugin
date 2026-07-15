import { afterAll, beforeAll } from "vitest";
import { AUT_KEY, client, phoneOf } from "./helpers.js";

const ENDED_CALL_STATUSES = new Set(["completed", "failed", "canceled"]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type InkboxClient = ReturnType<typeof client>;
type Call = Awaited<ReturnType<InkboxClient["calls"]["list"]>>[number];

let aut: InkboxClient | undefined;
let localPhone = "";
let baseline = new Set<string>();
let watcher: ReturnType<typeof setInterval> | undefined;
let checking = false;
const attempted = new Set<string>();

const statusOf = (call: Call) => (call.status ?? "").toLowerCase();

async function ownedCalls(): Promise<Map<string, Call>> {
  if (!aut) return new Map();
  const calls = await aut.calls.list({ limit: 100 });
  return new Map(
    calls.filter((call) => call.localPhoneNumber === localPhone).map((call) => [call.id, call]),
  );
}

async function hangup(call: Call): Promise<string | undefined> {
  if (!aut || ENDED_CALL_STATUSES.has(statusOf(call))) return undefined;
  try {
    await aut.calls.hangup(call.id);
    return undefined;
  } catch (error) {
    try {
      const current = await aut.calls.get(call.id);
      if (ENDED_CALL_STATUSES.has(statusOf(current))) return undefined;
      return `hangup=${String(error)}; status=${JSON.stringify(statusOf(current))}`;
    } catch (getError) {
      return `hangup=${String(error)}; get=${String(getError)}`;
    }
  }
}

async function newLiveCalls(): Promise<Map<string, Call>> {
  const current = await ownedCalls();
  return new Map(
    [...current].filter(
      ([callId, call]) => !baseline.has(callId) && !ENDED_CALL_STATUSES.has(statusOf(call)),
    ),
  );
}

async function watchOnce(): Promise<void> {
  for (const [callId, call] of await newLiveCalls()) {
    if (attempted.has(callId)) continue;
    attempted.add(callId);
    await hangup(call);
  }
}

async function finishNewCalls(): Promise<void> {
  const deadline = Date.now() + 12_000;
  const errors = new Map<string, string>();
  for (;;) {
    const live = await newLiveCalls();
    if (live.size === 0) return;
    for (const [callId, call] of live) {
      const error = await hangup(call);
      if (error) errors.set(callId, error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `live-test calls remained active after API cleanup: states=${JSON.stringify(
          Object.fromEntries([...live].map(([id, call]) => [id, statusOf(call)])),
        )} errors=${JSON.stringify(Object.fromEntries(errors))}`,
      );
    }
    await delay(500);
  }
}

beforeAll(async () => {
  if (!AUT_KEY) return;
  aut = client(AUT_KEY);
  localPhone = (await phoneOf(aut)).number;
  baseline = new Set((await ownedCalls()).keys());

  // Non-voice tests must never create calls. Stop an accidental model tool
  // choice immediately; voice tests own their expected call ids directly.
  if (!process.env.VOICE_SCENARIO) {
    watcher = setInterval(() => {
      if (checking) return;
      checking = true;
      void watchOnce()
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, 1000);
  }
}, 30_000);

afterAll(async () => {
  if (!aut) return;
  if (watcher) clearInterval(watcher);
  while (checking) await delay(50);
  await delay(1000);
  await finishNewCalls();
}, 30_000);
