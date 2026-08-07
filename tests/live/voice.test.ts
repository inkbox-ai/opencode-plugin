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
import { requireExactCallPair } from "./call-pairing.js";
import {
  AUT_KEY,
  callSegments,
  client,
  LIVE,
  listCalls,
  phoneOf,
  REAL_MODEL,
  REMOTE_KEY,
  waitDriverLocalSpeech,
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
  direction: string;
  status: string;
  useInkboxTts: boolean | null;
  useInkboxStt: boolean | null;
  hangupReason: string | null;
  isBlocked: boolean;
}) => ({
  direction: call.direction,
  status: call.status,
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
  } catch {
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
    throw new Error(`failed to hang up live test call; final status=${JSON.stringify(status)}`);
  }
}

const terminalStatuses = new Set(["completed", "canceled", "failed"]);

async function sweepActiveCalls(
  inkbox: ReturnType<typeof client>,
  matching: () => Promise<any[]>,
): Promise<void> {
  const active = (await matching()).filter(
    (call) => !terminalStatuses.has(String(call.status ?? "").toLowerCase()),
  );
  await Promise.allSettled(active.map((call) => hangupCall(inkbox, call.id)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const remaining = (await matching()).filter(
      (call) => !terminalStatuses.has(String(call.status ?? "").toLowerCase()),
    );
    if (remaining.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("matching active calls did not settle before the live scenario");
}

async function cleanupFreshCalls(
  inkbox: ReturnType<typeof client>,
  matching: () => Promise<any[]>,
  before: Set<string>,
): Promise<void> {
  const fresh = (await matching()).filter((call) => !before.has(call.id));
  const results = await Promise.allSettled(fresh.map((call) => hangupCall(inkbox, call.id)));
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("one or more fresh live-test calls could not be cleaned up");
  }
}

async function waitForStableCallPair(
  driverLegs: () => Promise<any[]>,
  autLegs: () => Promise<any[]>,
  beforeDriver: Set<string>,
  beforeAut: Set<string>,
  scenarioStartedAt: number,
  deadline: number,
): Promise<{ driver: any; aut: any }> {
  let stableKey: string | undefined;
  let stableSince = 0;
  let lastCounts = { driver: 0, aut: 0 };
  while (Date.now() < deadline) {
    const freshDriver = (await driverLegs()).filter(
      (call) => !beforeDriver.has(call.id) && (recordCreatedAt(call) ?? -1) >= scenarioStartedAt,
    );
    const freshAut = (await autLegs()).filter(
      (call) => !beforeAut.has(call.id) && (recordCreatedAt(call) ?? -1) >= scenarioStartedAt,
    );
    lastCounts = { driver: freshDriver.length, aut: freshAut.length };
    if (freshDriver.length > 1 || freshAut.length > 1) {
      return requireExactCallPair(freshDriver, freshAut, {
        scenarioStartedAt,
        maxCreationSkewMs: 60_000,
      });
    }
    if (freshDriver.length === 1 && freshAut.length === 1) {
      const pair = requireExactCallPair(freshDriver, freshAut, {
        scenarioStartedAt,
        maxCreationSkewMs: 60_000,
      });
      const key = `${pair.driver.id}:${pair.aut.id}`;
      if (key !== stableKey) {
        stableKey = key;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 6_000) {
        return pair;
      }
    } else {
      stableKey = undefined;
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `timed out waiting for one stable call record per owner; driver_records=${lastCounts.driver} aut_records=${lastCounts.aut}`,
  );
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
      const autTail = tail(autPhone.number);
      const driverTail = tail(st.number);
      const driverLegs = async () =>
        (await listCalls(remote)).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "outbound" &&
            tail(call.remotePhoneNumber ?? "") === autTail,
        );
      const autLegs = async () =>
        (await listCalls(aut)).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "inbound" &&
            tail(call.remotePhoneNumber ?? "") === driverTail,
        );

      // Server-side contact rules run before the plugin or its local allow-all
      // setting. Whitelisted smoke identities therefore need the driver allowed
      // explicitly or the call is rejected before either media WS connects.
      await ensureDriverAllowed(aut, st.number);
      await sweepActiveCalls(remote, driverLegs);
      await sweepActiveCalls(aut, autLegs);
      const beforeDriver = new Set((await driverLegs()).map((call) => call.id));
      const beforeAut = new Set((await autLegs()).map((call) => call.id));

      // Place the call to the agent, handing Inkbox the driver's own media WS.
      const scenarioStartedAt = Date.now() - 10_000;
      const call = await remote.calls.place({
        toNumber: autPhone.number,
        fromNumber: st.number,
        clientWebsocketUrl: st.ws_url,
        voicemailDetection: VoicemailDetection.DISABLED,
      });
      console.info(`inbound call placed: ${JSON.stringify(callSummary(call))}`);
      try {
        const pair = await waitForStableCallPair(
          driverLegs,
          autLegs,
          beforeDriver,
          beforeAut,
          scenarioStartedAt,
          Date.now() + VOICE_TIMEOUT_MS,
        );
        expect(pair.driver.id === call.id).toBe(true);
        const [driverSaid, agentSaid] = await Promise.all([
          waitDriverLocalSpeech(remote, pair.driver.id, VOICE_TIMEOUT_MS),
          waitTwoWayCall(aut, pair.aut.id, VOICE_TIMEOUT_MS),
        ]);
        expect(driverSaid.length).toBeGreaterThan(0);
        expect(agentSaid.length).toBeGreaterThan(0);
        const persistedDriverCall = await remote.calls.get(pair.driver.id);
        expect(String(persistedDriverCall.voicemailDetection).toLowerCase()).toBe("disabled");

        const mode = await aut.calls.get(pair.aut.id);
        expect(
          mode.useInkboxTts && mode.useInkboxStt,
          `inbound should use managed STT/TTS; ${JSON.stringify(callSummary(mode))}`,
        ).toBe(true);
        // Voicemail detection applies to the driver's outbound dial and is
        // proven on persistedDriverCall above. The mirrored AUT row is an
        // inbound carrier record and does not carry that outbound setting.
      } finally {
        await cleanupFreshCalls(remote, driverLegs, beforeDriver);
        await cleanupFreshCalls(aut, autLegs, beforeAut);
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
      const driverTail = tail(st.number);

      const inboundFromAut = async () =>
        (await listCalls(remote)).filter(
          (c) =>
            (c.direction ?? "").toLowerCase() === "inbound" &&
            tail(c.remotePhoneNumber ?? "") === autTail,
        );

      const outboundFromAut = async () =>
        (await listCalls(aut)).filter(
          (c) =>
            (c.direction ?? "").toLowerCase() === "outbound" &&
            tail(c.remotePhoneNumber ?? "") === driverTail,
        );
      await sweepActiveCalls(remote, inboundFromAut);
      await sweepActiveCalls(aut, outboundFromAut);
      const before = new Set((await inboundFromAut()).map((c) => c.id));
      const beforeAut = new Set((await outboundFromAut()).map((c) => c.id));
      const scenarioStartedAt = Date.now() - 10_000;
      const deadline = Date.now() + VOICE_TIMEOUT_MS;
      await remote.texts.send(st.number_id, {
        to: autPhone.number,
        text: "Please call me right now by phone and set voicemailDetection to disabled.",
      });

      try {
        const pair = await waitForStableCallPair(
          inboundFromAut,
          outboundFromAut,
          before,
          beforeAut,
          scenarioStartedAt,
          deadline,
        );
        const [driverSaid, agentSaid] = await Promise.all([
          waitDriverLocalSpeech(remote, pair.driver.id, VOICE_TIMEOUT_MS),
          waitTwoWayCall(aut, pair.aut.id, VOICE_TIMEOUT_MS),
        ]);
        expect(driverSaid.length).toBeGreaterThan(0);
        expect(agentSaid.length).toBeGreaterThan(0);
        const mode: any = await aut.calls.get(pair.aut.id);
        expect(
          mode.useInkboxTts === false && mode.useInkboxStt === false,
          `outbound should use Realtime speech; ${JSON.stringify(callSummary(mode))}`,
        ).toBe(true);
        // Voicemail detection belongs to the AUT's call-capable outbound request.
        // The driver's mirrored inbound leg can report its unrelated provider default.
        expect(String(mode.voicemailDetection).toLowerCase()).toBe("disabled");
      } finally {
        await cleanupFreshCalls(remote, inboundFromAut, before);
        await cleanupFreshCalls(aut, outboundFromAut, beforeAut);
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
      const progress = { phase: "baseline", last: "" };

      const driverLegs = async () =>
        (await listCalls(remote)).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "inbound" &&
            tail(call.remotePhoneNumber ?? "") === autTail,
        );
      const autLegs = async () =>
        (await listCalls(aut)).filter(
          (call) =>
            String(call.direction ?? "").toLowerCase() === "outbound" &&
            tail(call.remotePhoneNumber ?? "") === driverTail,
        );

      await sweepActiveCalls(remote, driverLegs);
      await sweepActiveCalls(aut, autLegs);
      const baselineDriverCalls = await driverLegs();
      const baselineAutCalls = await autLegs();
      const beforeDriverCalls = new Set(baselineDriverCalls.map((call) => call.id));
      const beforeAutCalls = new Set(baselineAutCalls.map((call) => call.id));
      const baseline = await outboundTextsTo(aut, autPhone.id, st.number);
      const beforeSmsIds = new Set(baseline.map((message: any) => message.id));
      const scenarioStartedAt = Date.now() - 10_000;
      const deadline = Date.now() + VOICE_TIMEOUT_MS;
      await remote.texts.send(st.number_id, {
        to: autPhone.number,
        text:
          "Use inkbox_place_call to call me now. Inkbox Voice AI must handle the call. " +
          "Set voicemailDetection to disabled. " +
          "The purpose is to complete my spoken request and record any post-call action. " +
          `Do not text before calling. Request ref ${Date.now().toString(36)}.`,
      });

      let autCallId: string | undefined;
      try {
        progress.phase = "hosted call placement";
        const pair = await waitForStableCallPair(
          driverLegs,
          autLegs,
          beforeDriverCalls,
          beforeAutCalls,
          scenarioStartedAt,
          deadline,
        );
        const currentDriverCallId = pair.driver.id;
        const currentAutCallId = pair.aut.id;
        autCallId = currentAutCallId;
        const call: any = await aut.calls.get(currentAutCallId);
        expect(String(call.mode?.value ?? call.mode).toLowerCase()).toBe("hosted_agent");
        expect(
          String(call.voicemailDetection?.value ?? call.voicemailDetection).toLowerCase(),
        ).toBe("disabled");
        expect(call.reason).toBeTruthy();
        expect(String(call.hostedAgentAuthorityMode?.value ?? call.hostedAgentAuthorityMode)).toBe(
          expectedAuthority,
        );
        const agentSaid = await waitTwoWayCall(aut, currentAutCallId, VOICE_TIMEOUT_MS);
        expect(agentSaid.length).toBeGreaterThan(0);

        while (Date.now() < deadline) {
          progress.phase = "pre-hangup caller and open-action readiness";
          const [driverSegments, autSegments, currentAutCall] = await Promise.all([
            callSegments(remote, currentDriverCallId).catch(() => ({ remote: [], local: [] })),
            callSegments(aut, currentAutCallId).catch(() => ({ remote: [], local: [] })),
            aut.calls.get(currentAutCallId),
          ]);
          const caller = driverSegments.local
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
            hasAfterCallSmsIntent(caller) && containsVoiceMarker(caller, HOSTED_MARKER);
          const matchingActions = actionEvidence.filter(
            (value: string) => hasSmsIntent(value) && containsVoiceMarker(value, HOSTED_MARKER),
          );
          const smsActionCount = actionEvidence.filter((value: string) =>
            hasSmsIntent(value),
          ).length;
          const markerActionCount = actionEvidence.filter((value: string) =>
            containsVoiceMarker(value, HOSTED_MARKER),
          ).length;
          const twoWayReady = autSegments.remote.length > 0 && autSegments.local.length > 0;
          const actionReady =
            openActions.length === 1 &&
            matchingActions.length === 1 &&
            smsActionCount === 1 &&
            markerActionCount === 1;
          progress.last =
            `agent_segments=${autSegments.local.length} two_way_ready=${twoWayReady} ` +
            `caller_ready=${callerReady} ` +
            `action_ready=${actionReady} open_actions=${openActions.length} ` +
            `sms_actions=${smsActionCount} marker_actions=${markerActionCount}`;
          if (twoWayReady && callerReady && actionReady) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        expect(progress.phase).toBe("pre-hangup caller and open-action readiness");
        expect(progress.last).toContain("two_way_ready=true");
        expect(progress.last).toContain("caller_ready=true");
        expect(progress.last).toContain("action_ready=true");
      } finally {
        await cleanupFreshCalls(remote, driverLegs, beforeDriverCalls);
        await cleanupFreshCalls(aut, autLegs, beforeAutCalls);
      }

      const duplicateGraceMs = 10_000;
      let matched: any[] = [];
      let registryEntry: any;
      while (Date.now() < deadline - duplicateGraceMs) {
        progress.phase = "post-call tool settlement";
        const fresh = (await outboundTextsTo(aut, autPhone.id, st.number)).filter(
          (message: any) => {
            const created = recordCreatedAt(message);
            return (
              !beforeSmsIds.has(message.id) && created !== undefined && created >= scenarioStartedAt
            );
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
              (recordCreatedAt(message) ?? -1) >= scenarioStartedAt &&
              containsVoiceMarker(String(message.text ?? ""), HOSTED_MARKER),
          );
          expect(afterGrace.length).toBe(1);
          return;
        }
        if (registryEntry?.state === "failed") throw new Error("hosted settlement failed");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error(`hosted SMS settlement timed out: ${JSON.stringify(progress)}`);
    },
  );
});
