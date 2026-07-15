// Live voice-call suite — real phone calls, real model, transcript-verified.
//
// A companion driver process (voice-driver.mjs) bridges the driver's side of a
// real call over its own Inkbox tunnel and speaks one line; we read the stored
// call transcript and assert both parties spoke. Two scenarios, each run
// against a gateway booted in the matching speech mode and selected by
// VOICE_SCENARIO:
//   inbound_inkbox    — driver calls the agent; agent answers Inkbox STT/TTS.
//   outbound_realtime — driver texts "call me"; agent calls back on Realtime.
import { readFileSync } from "node:fs";
import { PhoneRuleAction, PhoneRuleMatchType } from "@inkbox/sdk";
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  autSpeechMode,
  client,
  LIVE,
  phoneOf,
  pollUntil,
  REAL_MODEL,
  REMOTE_KEY,
  waitTwoWayCall,
} from "./helpers.js";

const SCENARIO = process.env.VOICE_SCENARIO ?? "";
const STATE_FILE = process.env.VOICE_DRIVER_STATE || "/tmp/voice_driver_state.json";
const VOICE_TIMEOUT_MS = Number(process.env.LIVE_VOICE_TIMEOUT_S || "220") * 1000;

interface DriverState {
  ws_url: string;
  number: string;
  number_id: string;
  handle: string;
}

const callSummary = (call: {
  id: string;
  direction: string;
  status: string;
  localPhoneNumber: string | null;
  remotePhoneNumber: string;
  clientWebsocketUrl: string | null;
  useInkboxTts: boolean | null;
  useInkboxStt: boolean | null;
  hangupReason: string | null;
  isBlocked: boolean;
}) => ({
  id: call.id,
  direction: call.direction,
  status: call.status,
  localPhoneNumber: call.localPhoneNumber,
  remotePhoneNumber: call.remotePhoneNumber,
  clientWebsocketUrl: call.clientWebsocketUrl,
  useInkboxTts: call.useInkboxTts,
  useInkboxStt: call.useInkboxStt,
  hangupReason: call.hangupReason,
  isBlocked: call.isBlocked,
});

function driverState(): DriverState {
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

async function ensureDriverAllowed(
  aut: ReturnType<typeof client>,
  driverNumber: string,
): Promise<void> {
  const mailbox = (await aut.mailboxes.list())[0];
  if (!mailbox) throw new Error("AUT identity has no mailbox");
  const handle = mailbox.emailAddress.split("@", 1)[0];
  const rules = await aut.phoneIdentityContactRules.list(handle);
  const activeAllow = rules.some(
    (rule) =>
      rule.matchTarget === driverNumber && rule.action === "allow" && rule.status === "active",
  );
  if (!activeAllow) {
    await aut.phoneIdentityContactRules.create(handle, {
      action: PhoneRuleAction.ALLOW,
      matchType: PhoneRuleMatchType.EXACT_NUMBER,
      matchTarget: driverNumber,
    });
  }
}

const tail = (s: string) => s.replace(/\D/g, "").slice(-10);

async function hangupCall(
  inkbox: ReturnType<typeof client>,
  callId: string | undefined,
): Promise<void> {
  if (!callId) return;
  try {
    await inkbox.calls.hangup(callId);
    return;
  } catch (hangupError) {
    let status = "unknown";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        status = ((await inkbox.calls.get(callId)).status ?? "").toLowerCase();
      } catch {
        status = "unknown";
      }
      if (["completed", "canceled", "failed"].includes(status)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `failed to hang up live test call ${callId}; status=${JSON.stringify(status)}; error=${String(hangupError)}`,
    );
  }
}

describe.skipIf(!LIVE || !REAL_MODEL)("live voice", () => {
  it.skipIf(SCENARIO !== "inbound_inkbox")(
    "inbound: driver calls, agent answers via Inkbox STT/TTS and replies",
    { timeout: VOICE_TIMEOUT_MS + 60_000 },
    async () => {
      const st = driverState();
      const remote = client(REMOTE_KEY as string);
      const aut = client(AUT_KEY as string);
      const autPhone = await phoneOf(aut);

      // Server-side contact rules run before the plugin or its local allow-all
      // setting. Whitelisted smoke identities therefore need the driver allowed
      // explicitly or the call is rejected before either media WS connects.
      await ensureDriverAllowed(aut, st.number);

      // Place the call to the agent, handing Inkbox the driver's own media WS.
      const call = await remote.calls.place({
        toNumber: autPhone.number,
        fromNumber: st.number,
        clientWebsocketUrl: st.ws_url,
      });
      console.info(`inbound call placed: ${JSON.stringify(callSummary(call))}`);
      try {
        let agentSaid: string;
        try {
          agentSaid = await waitTwoWayCall(remote, call.id, VOICE_TIMEOUT_MS);
        } catch (error) {
          const [driverCall, autCalls, incomingAction, rules] = await Promise.all([
            remote.calls.get(call.id).catch((cause) => ({ error: String(cause) })),
            aut.calls.list({ limit: 10 }).catch((cause) => [{ error: String(cause) }]),
            aut.incomingCallAction.get().catch((cause) => ({ error: String(cause) })),
            aut.phoneIdentityContactRules
              .list((await aut.mailboxes.list())[0]?.emailAddress.split("@", 1)[0] ?? "")
              .catch((cause) => [{ error: String(cause) }]),
          ]);
          throw new Error(
            `${String(error)}; inbound diagnostics=${JSON.stringify({
              placedCall: callSummary(call),
              driverCall,
              autCalls,
              incomingAction,
              rules,
            })}`,
          );
        }
        expect(agentSaid.length).toBeGreaterThan(0);

        const mode = await autSpeechMode(aut, "inbound", st.number);
        expect(mode, "no answered inbound AUT call with the driver").toBeDefined();
        expect(
          mode?.tts && mode?.stt,
          `inbound should be Inkbox STT/TTS, got ${JSON.stringify(mode)}`,
        ).toBe(true);
      } finally {
        await hangupCall(remote, call.id);
      }
    },
  );

  it.skipIf(SCENARIO !== "outbound_realtime")(
    "outbound: 'call me' text → agent calls back on the Realtime path and replies",
    { timeout: VOICE_TIMEOUT_MS + 60_000 },
    async () => {
      const st = driverState();
      const remote = client(REMOTE_KEY as string);
      const aut = client(AUT_KEY as string);
      const autPhone = await phoneOf(aut);
      const autTail = tail(autPhone.number);

      const inboundFromAut = async () =>
        (await remote.calls.list({ limit: 30 })).filter(
          (c) =>
            (c.direction ?? "").toLowerCase() === "inbound" &&
            tail(c.remotePhoneNumber ?? "") === autTail,
        );

      const before = new Set((await inboundFromAut()).map((c) => c.id));
      await remote.texts.send(st.number_id, {
        to: autPhone.number,
        text: "Please call me right now by phone — give me a ring.",
      });

      let call: Awaited<ReturnType<typeof inboundFromAut>>[number] | undefined;
      try {
        call = await pollUntil(
          "agent call-back",
          async () => (await inboundFromAut()).find((c) => !before.has(c.id)),
          VOICE_TIMEOUT_MS,
        );
        const agentSaid = await waitTwoWayCall(remote, call.id, VOICE_TIMEOUT_MS);
        expect(agentSaid.length).toBeGreaterThan(0);

        const mode = await autSpeechMode(aut, "outbound", st.number);
        expect(mode, "no answered outbound AUT call with the driver").toBeDefined();
        expect(
          mode?.tts === false && mode?.stt === false,
          `outbound should be Realtime, got ${JSON.stringify(mode)}`,
        ).toBe(true);
      } finally {
        await hangupCall(remote, call?.id);
      }
    },
  );
});
