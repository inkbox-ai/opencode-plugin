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
//      VOICE_DRIVER_LINE, VOICE_DRIVER_SPEAK_AFTER (s), VOICE_DRIVER_LISTEN (s)
import { writeFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";
import { connect } from "@inkbox/sdk/tunnels/connect";

const API_KEY = process.env.REMOTE_INKBOX_API_KEY;
const BASE_URL = process.env.INKBOX_BASE_URL || "https://inkbox.ai";
const STATE_FILE = process.env.VOICE_DRIVER_STATE || "/tmp/voice_driver_state.json";
const LINE =
  process.env.VOICE_DRIVER_LINE ||
  "Hi, this is a quick test call. Please reply out loud with one short sentence, then say goodbye.";
// Speak shortly after the pipeline is ready so the agent's greeting lands first,
// then give the agent a turn and hang up (a dropped WS does NOT end the call — an
// explicit stop is required or the leg lingers to the server max-duration cap).
const SPEAK_AFTER_MS = Number(process.env.VOICE_DRIVER_SPEAK_AFTER || "3") * 1000;
const LISTEN_MS = Number(process.env.VOICE_DRIVER_LISTEN || "12") * 1000;

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
  let spoke = false;
  const speak = async (text) => {
    if (spoke) return;
    spoke = true;
    await ws.send(JSON.stringify({ event: "text", delta: text }));
    await ws.send(JSON.stringify({ event: "text", done: true }));
    console.log("spoke:", text);
  };
  const runTurn = async () => {
    await sleep(SPEAK_AFTER_MS);
    await speak(LINE);
    await sleep(LISTEN_MS);
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
      } else if (ev.event === "transcript" && ev.is_final) {
        console.log("heard (final):", ev.text);
        await speak(LINE); // speak now if the greeting beat our timer
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
