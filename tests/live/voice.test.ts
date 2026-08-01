// Live voice-call suite — real phone calls, real model, transcript-verified.
//
// A companion driver process (voice-driver.mjs) bridges the driver's side of a
// real call over its own Inkbox tunnel and speaks one line; we read the stored
// call transcript and assert both parties spoke. Three scenarios, each run
// against a gateway booted in the matching speech mode and selected by
// VOICE_SCENARIO:
//   inbound_inkbox    — driver calls the agent; agent answers Inkbox STT/TTS.
//   outbound_realtime — driver texts "call me"; agent calls back on Realtime.
//   outbound_hosted   — Voice AI calls, then settles one exact post-call SMS.
import { readFileSync } from "node:fs";
import { PhoneRuleAction, PhoneRuleMatchType, VoicemailDetection } from "@inkbox/sdk";
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  autSpeechMode,
  callSegments,
  client,
  inboundTextsFrom,
  LIVE,
  phoneOf,
  pollUntil,
  REAL_MODEL,
  REMOTE_KEY,
  waitTwoWayCall,
} from "./helpers.js";
import { containsVoiceMarker, hasAfterCallSmsIntent, hasSmsIntent } from "./voice-proof.js";

const SCENARIO = process.env.VOICE_SCENARIO ?? "";
const STATE_FILE = process.env.VOICE_DRIVER_STATE || "/tmp/voice_driver_state.json";
const VOICE_TIMEOUT_MS = Number(process.env.LIVE_VOICE_TIMEOUT_S || "220") * 1000;
const HOSTED_MARKER = process.env.HOSTED_POST_CALL_MARKER || "";

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
function recordCreatedAt(record: any): number | undefined {
  const value = record?.createdAt ?? record?.created_at;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function smsTargets(message: any): Set<string> {
  const values = [message?.remotePhoneNumber ?? message?.remote_phone_number ?? ""];
  for (const recipient of message?.recipients ?? []) {
    values.push(recipient?.recipientPhoneNumber ?? recipient?.recipient_phone_number ?? "");
  }
  return new Set(values.map((value) => String(value).replace(/\D/g, "")).filter(Boolean));
}

async function outboundTextsTo(inkbox: ReturnType<typeof client>, numberId: string, to: string) {
  const target = to.replace(/\D/g, "");
  return (await inkbox.texts.list(numberId, { limit: 200 })).filter(
    (message: any) =>
      String(message.direction ?? "").toLowerCase() === "outbound" &&
      smsTargets(message).has(target),
  );
}

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
      const beforeAutCalls = new Set((await aut.calls.list({ limit: 30 })).map((item) => item.id));

      // Server-side contact rules run before the plugin or its local allow-all
      // setting. Whitelisted smoke identities therefore need the driver allowed
      // explicitly or the call is rejected before either media WS connects.
      await ensureDriverAllowed(aut, st.number);

      // Place the call to the agent, handing Inkbox the driver's own media WS.
      const call = await remote.calls.place({
        toNumber: autPhone.number,
        fromNumber: st.number,
        clientWebsocketUrl: st.ws_url,
        voicemailDetection: VoicemailDetection.DISABLED,
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
        const persistedDriverCall = await remote.calls.get(call.id);
        expect(String(persistedDriverCall.voicemailDetection).toLowerCase()).toBe("disabled");

        const mode = await autSpeechMode(aut, "inbound", st.number, beforeAutCalls);
        expect(mode, "no answered inbound AUT call with the driver").toBeDefined();
        expect(
          mode?.tts && mode?.stt,
          `inbound should be Inkbox STT/TTS, got ${JSON.stringify(mode)}`,
        ).toBe(true);
        // Voicemail detection applies to the driver's outbound dial and is
        // proven on persistedDriverCall above. The mirrored AUT row is an
        // inbound carrier record and does not carry that outbound setting.
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
      const beforeAutCalls = new Set((await aut.calls.list({ limit: 30 })).map((item) => item.id));

      const inboundFromAut = async () =>
        (await remote.calls.list({ limit: 30 })).filter(
          (c) =>
            (c.direction ?? "").toLowerCase() === "inbound" &&
            tail(c.remotePhoneNumber ?? "") === autTail,
        );

      const before = new Set((await inboundFromAut()).map((c) => c.id));
      const beforeTexts = new Set(
        (await inboundTextsFrom(remote, st.number_id, autPhone.number)).map(
          (message) => message.id,
        ),
      );
      await remote.texts.send(st.number_id, {
        to: autPhone.number,
        text: "Please call me right now by phone and set voicemailDetection to disabled.",
      });

      let call: Awaited<ReturnType<typeof inboundFromAut>>[number] | undefined;
      try {
        try {
          call = await pollUntil(
            "agent call-back",
            async () => (await inboundFromAut()).find((c) => !before.has(c.id)),
            VOICE_TIMEOUT_MS,
          );
        } catch (error) {
          const replies = (await inboundTextsFrom(remote, st.number_id, autPhone.number)).filter(
            (message) => !beforeTexts.has(message.id),
          );
          throw new Error(`${String(error)}; AUT SMS replies=${JSON.stringify(replies)}`);
        }
        const agentSaid = await waitTwoWayCall(remote, call.id, VOICE_TIMEOUT_MS);
        expect(agentSaid.length).toBeGreaterThan(0);
        const persistedDriverCall = await remote.calls.get(call.id);
        expect(String(persistedDriverCall.voicemailDetection).toLowerCase()).toBe("disabled");

        const mode = await autSpeechMode(aut, "outbound", st.number, beforeAutCalls);
        expect(mode, "no answered outbound AUT call with the driver").toBeDefined();
        expect(
          mode?.tts === false && mode?.stt === false,
          `outbound should be Realtime, got ${JSON.stringify(mode)}`,
        ).toBe(true);
        expect(String(mode?.voicemailDetection).toLowerCase()).toBe("disabled");
      } finally {
        await hangupCall(remote, call?.id);
      }
    },
  );

  it.skipIf(SCENARIO !== "outbound_hosted")(
    "outbound: Voice AI call settles one exact-target post-call SMS",
    { timeout: VOICE_TIMEOUT_MS + 60_000 },
    async () => {
      expect(HOSTED_MARKER, "HOSTED_POST_CALL_MARKER is required").not.toBe("");
      const st = driverState();
      const remote = client(REMOTE_KEY as string);
      const aut = client(AUT_KEY as string);
      const autPhone = await phoneOf(aut);
      const autTail = tail(autPhone.number);
      const driverTail = tail(st.number);
      const autMailbox = (await aut.mailboxes.list())[0];
      if (!autMailbox) throw new Error("AUT identity has no mailbox");
      const autHandle = autMailbox.emailAddress.split("@", 1)[0];
      const autIdentity = await aut.getIdentity(autHandle);
      const savedAuthority = (await autIdentity.getHostedAgentConfig()).authorityMode;
      const expectedAuthority = String((savedAuthority as any)?.value ?? savedAuthority);
      const deadline = Date.now() + VOICE_TIMEOUT_MS;
      const progress = { phase: "baseline", last: "" };

      const driverLegs = async () =>
        (await remote.calls.list({ limit: 30 })).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "inbound" &&
            tail(call.remotePhoneNumber ?? "") === autTail,
        );
      const autLegs = async () =>
        (await aut.calls.list({ limit: 30 })).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "outbound" &&
            tail(call.remotePhoneNumber ?? "") === driverTail,
        );

      const baselineDriverCalls = await driverLegs();
      const baselineAutCalls = await autLegs();
      const beforeDriverCalls = new Set(baselineDriverCalls.map((call) => call.id));
      const beforeAutCalls = new Set(baselineAutCalls.map((call) => call.id));
      const driverCallWatermark = Math.max(
        0,
        ...baselineDriverCalls
          .map(recordCreatedAt)
          .filter((value): value is number => value !== undefined),
      );
      const autCallWatermark = Math.max(
        0,
        ...baselineAutCalls
          .map(recordCreatedAt)
          .filter((value): value is number => value !== undefined),
      );
      const baseline = await outboundTextsTo(aut, autPhone.id, st.number);
      const beforeSmsIds = new Set(baseline.map((message: any) => message.id));
      const watermark = Math.max(
        0,
        ...baseline.map(recordCreatedAt).filter((value): value is number => value !== undefined),
      );

      await remote.texts.send(st.number_id, {
        to: autPhone.number,
        text:
          "Use inkbox_place_call to call me now. Inkbox Voice AI must handle the call. " +
          "The purpose is to complete my spoken request and record any post-call action. " +
          `Do not text before calling. Request ref ${Date.now().toString(36)}.`,
      });

      let driverCallId: string | undefined;
      let autCallId: string | undefined;
      try {
        while (Date.now() < deadline) {
          progress.phase = "hosted call placement";
          const freshDriver = (await driverLegs())
            .filter(
              (call) =>
                !beforeDriverCalls.has(call.id) &&
                (recordCreatedAt(call) ?? -1) >= driverCallWatermark,
            )
            .sort((left, right) => (recordCreatedAt(right) ?? 0) - (recordCreatedAt(left) ?? 0));
          const freshAut = (await autLegs())
            .filter(
              (call) =>
                !beforeAutCalls.has(call.id) && (recordCreatedAt(call) ?? -1) >= autCallWatermark,
            )
            .sort((left, right) => (recordCreatedAt(right) ?? 0) - (recordCreatedAt(left) ?? 0));
          progress.last = `driver_records=${freshDriver.length} aut_records=${freshAut.length}`;
          if (freshDriver[0] && freshAut[0]) {
            driverCallId = freshDriver[0].id;
            autCallId = freshAut[0].id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        expect(driverCallId && autCallId, JSON.stringify(progress)).toBeTruthy();
        if (!driverCallId || !autCallId) throw new Error(JSON.stringify(progress));
        const call: any = await aut.calls.get(autCallId);
        const driverCall: any = await remote.calls.get(driverCallId);
        const driverCreatedAt = recordCreatedAt(driverCall);
        const autCreatedAt = recordCreatedAt(call);
        expect(driverCreatedAt).toBeDefined();
        expect(autCreatedAt).toBeDefined();
        expect(Math.abs((driverCreatedAt ?? 0) - (autCreatedAt ?? 0))).toBeLessThanOrEqual(60_000);
        expect(String(call.mode?.value ?? call.mode).toLowerCase()).toBe("hosted_agent");
        expect(
          String(call.voicemailDetection?.value ?? call.voicemailDetection).toLowerCase(),
        ).toBe("disabled");
        expect(call.reason).toBeTruthy();
        expect(String(call.hostedAgentAuthorityMode?.value ?? call.hostedAgentAuthorityMode)).toBe(
          expectedAuthority,
        );

        while (Date.now() < deadline) {
          progress.phase = "pre-hangup caller and open-action readiness";
          const [segments, currentAutCall] = await Promise.all([
            callSegments(remote, driverCallId).catch(() => ({ agent: [], driver: [] })),
            aut.calls.get(autCallId),
          ]);
          const caller = segments.driver
            .join(" ")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ");
          const openActions = (currentAutCall.postCallActionItems ?? []).filter(
            (item: any) => String(item.status ?? "").toLowerCase() === "open",
          );
          const actionEvidence = openActions.map((item: any) =>
            [item.action, item.details].filter(Boolean).join(" "),
          );
          const callerReady =
            segments.agent.length > 0 &&
            hasAfterCallSmsIntent(caller) &&
            containsVoiceMarker(caller, HOSTED_MARKER);
          const actionReady = actionEvidence.some(
            (value: string) => hasSmsIntent(value) && containsVoiceMarker(value, HOSTED_MARKER),
          );
          progress.last =
            `agent_segments=${segments.agent.length} caller_ready=${callerReady} ` +
            `action_ready=${actionReady} open_actions=${JSON.stringify(actionEvidence)}`;
          if (callerReady && actionReady) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        expect(progress.phase).toBe("pre-hangup caller and open-action readiness");
        expect(progress.last).toContain("caller_ready=true");
        expect(progress.last).toContain("action_ready=true");
      } finally {
        await hangupCall(remote, driverCallId);
      }

      const duplicateGraceMs = 10_000;
      let matched: any[] = [];
      let registryEntry: any;
      while (Date.now() < deadline - duplicateGraceMs) {
        progress.phase = "post-call tool settlement";
        const fresh = (await outboundTextsTo(aut, autPhone.id, st.number)).filter(
          (message: any) => {
            const created = recordCreatedAt(message);
            return !beforeSmsIds.has(message.id) && created !== undefined && created >= watermark;
          },
        );
        matched = fresh.filter((message: any) =>
          containsVoiceMarker(String(message.text ?? ""), HOSTED_MARKER),
        );
        try {
          const registry = JSON.parse(
            readFileSync(
              `${process.env.HOME}/.inkbox-opencode/hosted-call-completions.json`,
              "utf8",
            ),
          );
          registryEntry = Object.values(registry).find((entry: any) => entry.callId === autCallId);
        } catch {
          registryEntry = undefined;
        }
        progress.last = `marker_rows=${matched.length} registry_state=${registryEntry?.state ?? "missing"}`;
        if (matched.length === 1 && registryEntry?.state === "completed") {
          await new Promise((resolve) => setTimeout(resolve, duplicateGraceMs));
          const afterGrace = (await outboundTextsTo(aut, autPhone.id, st.number)).filter(
            (message: any) =>
              !beforeSmsIds.has(message.id) &&
              (recordCreatedAt(message) ?? -1) >= watermark &&
              containsVoiceMarker(String(message.text ?? ""), HOSTED_MARKER),
          );
          expect(afterGrace).toHaveLength(1);
          return;
        }
        if (registryEntry?.state === "failed")
          throw new Error(`hosted settlement failed: ${JSON.stringify(registryEntry)}`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error(`hosted SMS settlement timed out: ${JSON.stringify(progress)}`);
    },
  );
});
