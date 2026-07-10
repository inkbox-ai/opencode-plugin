// Live voice-call suite — real phone calls, real model, transcript-verified.
//
// A companion driver process (voice-driver.mjs) bridges the driver's side of a
// real call over its own Inkbox tunnel and speaks one line; we read the stored
// call transcript and assert both parties spoke. Three scenarios, each run
// against a gateway booted in the matching speech mode and selected by
// VOICE_SCENARIO:
//   inbound_inkbox            — driver calls the agent; agent answers Inkbox STT/TTS.
//   outbound_realtime         — driver texts "call me"; agent calls back on Realtime.
//   outbound_realtime_contact — same, but the driver asks for a seeded contact's
//                               email; the agent must speak it (direct contact read).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  autSpeechMode,
  callSegments,
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
const GATEWAY_LOG = process.env.AUT_GATEWAY_LOG || "";
const VOICE_TIMEOUT_MS = Number(process.env.LIVE_VOICE_TIMEOUT_S || "220") * 1000;

interface DriverState {
  ws_url: string;
  number: string;
  number_id: string;
  handle: string;
}
function driverState(): DriverState {
  return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
}

const tail = (s: string) => s.replace(/\D/g, "").slice(-10);

// Seeded contact for the mid-call lookup leg. Fixed (not random) so the
// workflow can bake the matching question into the driver's line. The name must
// survive TWO audio hops (driver TTS → Realtime ASR), so it stays phonetically
// ordinary; the assertion strips spaces before matching.
const LOOKUP_GIVEN = "Olivia";
const LOOKUP_FAMILY = "Parker";
const LOOKUP_EMAIL = "olivia.parker.livetest@example.com";

describe.skipIf(!LIVE || !REAL_MODEL)("live voice", () => {
  it.skipIf(SCENARIO !== "inbound_inkbox")(
    "inbound: driver calls, agent answers via Inkbox STT/TTS and replies",
    { timeout: VOICE_TIMEOUT_MS + 60_000 },
    async () => {
      const st = driverState();
      const remote = client(REMOTE_KEY as string);
      const aut = client(AUT_KEY as string);
      const autPhone = await phoneOf(aut);

      // Place the call to the agent, handing Inkbox the driver's own media WS.
      const call = await remote.calls.place({
        toNumber: autPhone.number,
        fromNumber: st.number,
        clientWebsocketUrl: st.ws_url,
      });
      const agentSaid = await waitTwoWayCall(remote, call.id, VOICE_TIMEOUT_MS);
      expect(agentSaid.length).toBeGreaterThan(0);

      const mode = await autSpeechMode(aut, "inbound", st.number);
      expect(mode, "no answered inbound AUT call with the driver").toBeDefined();
      expect(
        mode?.tts && mode?.stt,
        `inbound should be Inkbox STT/TTS, got ${JSON.stringify(mode)}`,
      ).toBe(true);
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

      const call = await pollUntil(
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
    },
  );

  it.skipIf(SCENARIO !== "outbound_realtime_contact")(
    "outbound realtime: agent speaks a seeded contact's email via a direct read",
    { timeout: VOICE_TIMEOUT_MS + 90_000 },
    async () => {
      const st = driverState();
      const remote = client(REMOTE_KEY as string);
      const aut = client(AUT_KEY as string);
      const autPhone = await phoneOf(aut);
      const autTail = tail(autPhone.number);

      // The driver must be a recognized contact (the Realtime prompt refuses to
      // recite third-party details to an unrecognized caller), and the looked-up
      // card must exist with a distinctive email.
      if ((await aut.contacts.lookup({ phone: st.number })).length === 0) {
        await aut.contacts.create({
          givenName: "Penny",
          familyName: "Tester",
          phones: [{ label: "mobile", value: st.number, isPrimary: true }],
        });
      }
      for (const c of await aut.contacts.lookup({ email: LOOKUP_EMAIL })) {
        await aut.contacts.delete(c.id);
      }
      await aut.contacts.create({
        givenName: LOOKUP_GIVEN,
        familyName: LOOKUP_FAMILY,
        emails: [{ label: "work", value: LOOKUP_EMAIL, isPrimary: true }],
      });

      try {
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
        const call = await pollUntil(
          "agent call-back",
          async () => (await inboundFromAut()).find((c) => !before.has(c.id)),
          VOICE_TIMEOUT_MS,
        );

        // Poll the transcript until the agent's speech carries the surname + the
        // email's domain. Strip spaces so "zebra wood" still matches a surname.
        const heard = await pollUntil(
          "agent speaks the contact email",
          async () => {
            const { agent } = await callSegments(remote, call.id).catch(() => ({ agent: [] }));
            const squashed = agent.join(" ").toLowerCase().replace(/\s/g, "");
            return squashed.includes(LOOKUP_FAMILY.toLowerCase()) && squashed.includes("example")
              ? agent.join(" | ")
              : undefined;
          },
          VOICE_TIMEOUT_MS,
        );
        expect(heard.length).toBeGreaterThan(0);

        // Non-LLM proof the DIRECT contact tool served it (not a consult loop).
        if (GATEWAY_LOG) {
          const log = readFileSync(GATEWAY_LOG, "utf-8");
          expect(log, "gateway log shows no direct contact read during the call").toContain(
            "call.contact_read",
          );
        }

        const mode = await autSpeechMode(aut, "outbound", st.number);
        expect(
          mode?.tts === false && mode?.stt === false,
          `must be Realtime, got ${JSON.stringify(mode)}`,
        ).toBe(true);
      } finally {
        for (const c of await aut.contacts.lookup({ email: LOOKUP_EMAIL })) {
          await aut.contacts.delete(c.id).catch(() => {});
        }
      }
    },
  );
});
