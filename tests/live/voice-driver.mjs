// Live voice-call driver: the peer on the other end of a real phone call.
//
// Opens the driver identity's Inkbox tunnel, serves the call-media WebSocket
// behind it in Inkbox STT/TTS mode (text frames only — no local model), speaks
// one scripted line so the agent-under-test gets a turn, then hangs up. The
// stored call transcript (read by the test) proves the agent replied out loud.
//
// Two directions share one bridge: the test places a call to the agent and
// passes this driver's WS URL, or the agent calls the driver's number, which is
// set to auto-accept onto the same WS URL. On startup it writes a JSON state
// file (ws url + phone-number id) the test reads.
//
// Env: REMOTE_INKBOX_API_KEY, INKBOX_BASE_URL, VOICE_DRIVER_STATE,
//      VOICE_DRIVER_LINE, VOICE_DRIVER_SPEAK_AFTER (s), VOICE_DRIVER_LISTEN (s),
//      VOICE_DRIVER_REASK (s), VOICE_DRIVER_QUIET_GAP (s), VOICE_DRIVER_MAX_REASKS,
//      VOICE_DRIVER_ANSWER_CONTAINS,
//      VOICE_DRIVER_AUTO_STOP (false lets the test own hangup timing)
import { writeFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";

const API_KEY = process.env.REMOTE_INKBOX_API_KEY;
const BASE_URL = process.env.INKBOX_BASE_URL || "https://inkbox.ai";
const STATE_FILE = process.env.VOICE_DRIVER_STATE || "/tmp/voice_driver_state.json";
const LINE =
  process.env.VOICE_DRIVER_LINE ||
  "Hi, this is a quick test call. Please reply out loud with one short sentence, then say goodbye.";
// Answering-machine detection scores whoever answers: a greeting longer than the
// carrier's `greeting_duration_millis` (3.5s) reads as a voicemail announcement
// and the call is hung up before the agent ever speaks. Answer the way a person
// does — one word, then silence — and hold the prompt until that window closes.
const GREETING = process.env.VOICE_DRIVER_GREETING || "Hello?";
// Wait through the initial greeting before asking: speaking on a fixed timer
// can clip the request or its marker while the other party is still talking.
const SPEAK_AFTER_MS = Number(process.env.VOICE_DRIVER_SPEAK_AFTER || "5") * 1000;
const LISTEN_MS = Number(process.env.VOICE_DRIVER_LISTEN || "12") * 1000;
// Re-ask the question this often while the agent is idle. An ask the greeting
// talked over is otherwise never repeated and the call idles out with the agent
// still waiting for a request. 0 disables re-asking.
const REASK_EVERY_MS = Number(process.env.VOICE_DRIVER_REASK || "20") * 1000;
// Never re-ask until the agent has been silent this long, so a reply or a tool
// round-trip in progress is never talked over.
const QUIET_GAP_MS = Number(process.env.VOICE_DRIVER_QUIET_GAP || "6") * 1000;
const MAX_REASKS = Number(process.env.VOICE_DRIVER_MAX_REASKS || "2");
// The agent saying this back means the question landed; stop re-asking so a
// question that already took effect never turns into a second one.
const ANSWER_CONTAINS = process.env.VOICE_DRIVER_ANSWER_CONTAINS || "";
const AUTO_STOP = process.env.VOICE_DRIVER_AUTO_STOP !== "false";

// Compare speech ignoring ASR casing, spacing and punctuation.
const speechKey = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const ANSWER_KEY = speechKey(ANSWER_CONTAINS);

if (!API_KEY) {
  console.error("REMOTE_INKBOX_API_KEY required");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inkbox = new Inkbox({ apiKey: API_KEY, baseUrl: BASE_URL });
const handle = (await inkbox.mailboxes.list())[0].emailAddress.split("@")[0];
const number = (await inkbox.phoneNumbers.list())[0];
const identity = await inkbox.getIdentity(handle);
console.log(`driver identity ${handle} number ${number.number}`);

// Accept the call-media WS in Inkbox STT/TTS mode and run one scripted turn.
async function callWsHandler(ws) {
  await ws.accept({
    headers: [
      ["x-use-inkbox-text-to-speech", "true"],
      ["x-use-inkbox-speech-to-text", "true"],
    ],
  });
  console.log("call WS accepted");
  let answered = false;
  let lastHeardAt = 0;
  const say = async (text) => {
    await ws.send(JSON.stringify({ event: "text", delta: text }));
    await ws.send(JSON.stringify({ event: "text", done: true }));
    console.log("spoke:", text);
  };
  const waitForGreeting = async () => {
    const deadline = Date.now() + Math.max(30_000, SPEAK_AFTER_MS + QUIET_GAP_MS);
    await sleep(SPEAK_AFTER_MS);
    while (true) {
      const now = Date.now();
      const quietIn = QUIET_GAP_MS - (now - lastHeardAt);
      if (quietIn <= 0) return true;
      if (now >= deadline) return false;
      await sleep(Math.min(quietIn, deadline - now));
    }
  };
  const runTurn = async () => {
    await say(GREETING);
    if (!(await waitForGreeting())) {
      console.log("peer did not pause before the greeting deadline");
      if (AUTO_STOP) {
        try {
          await ws.send(JSON.stringify({ event: "stop" }));
        } catch {
          /* already closing */
        }
      }
      return;
    }
    await say(LINE);
    let askedAt = Date.now();
    lastHeardAt = askedAt;
    // Re-ask if the agent never got the question: the greeting routinely runs
    // several seconds past our first ask, and a lost ask leaves the agent waiting
    // while the call idles out. Re-ask ONLY once the agent has gone quiet and has
    // not already answered, so neither an in-progress reply nor a question that
    // already landed is spoken over or repeated.
    const startedAt = Date.now();
    let reasks = 0;
    while (Date.now() - startedAt < LISTEN_MS) {
      await sleep(1000);
      if (
        REASK_EVERY_MS > 0 &&
        !answered &&
        reasks < MAX_REASKS &&
        Date.now() - askedAt >= REASK_EVERY_MS &&
        Date.now() - lastHeardAt >= QUIET_GAP_MS
      ) {
        await say(LINE);
        askedAt = Date.now();
        reasks += 1;
      }
    }
    if (!AUTO_STOP) return;
    try {
      await ws.send(JSON.stringify({ event: "stop" }));
      console.log("sent stop (hangup)");
    } catch {
      /* already closing */
    }
  };
  try {
    for await (const raw of ws) {
      let ev;
      try {
        ev = JSON.parse(String(raw));
      } catch {
        continue;
      }
      if (ev.event === "start") {
        console.log("call start");
        void runTurn();
      } else if (ev.event === "transcript") {
        lastHeardAt = Date.now();
        if (ev.is_final) {
          console.log("heard (final):", ev.text);
          if (ANSWER_KEY && speechKey(String(ev.text || "")).includes(ANSWER_KEY)) {
            answered = true;
          }
        }
      } else if (ev.event === "stop") {
        console.log("call stop");
        break;
      }
    }
  } catch (e) {
    console.log("WS loop ended:", String(e));
  } finally {
    try {
      await ws.close();
    } catch {
      /* already closing */
    }
  }
}

const listener = await connect(inkbox, {
  name: handle, // tunnel name = handle
  handler: () => new Response("ok"), // trivial HTTP path (wsHandler requires one)
  wsHandler: callWsHandler,
  installSignalHandlers: false,
});
const wsUrl = `wss://${listener.tunnel.publicHost}/phone/media/ws`;
console.log("tunnel ready:", wsUrl);

// Auto-accept inbound calls (agent → driver) straight onto this WS.
await identity.setIncomingCallAction({
  incomingCallAction: "auto_accept",
  clientWebsocketUrl: wsUrl,
});

writeFileSync(
  STATE_FILE,
  JSON.stringify({ ws_url: wsUrl, number: number.number, number_id: number.id, handle }),
);
console.log("state written to", STATE_FILE);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Leave the number as we found it so other suites aren't affected.
  try {
    await identity.setIncomingCallAction({
      incomingCallAction: "auto_reject",
      clientWebsocketUrl: wsUrl,
    });
  } catch {
    /* best effort */
  }
  try {
    await listener.close();
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
await listener.wait();
