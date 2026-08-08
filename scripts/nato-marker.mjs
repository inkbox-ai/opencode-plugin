import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SPEECH_WORDS = [
  "banana",
  "elephant",
  "pineapple",
  "alligator",
  "motorcycle",
  "umbrella",
  "dinosaur",
  "potato",
  "computer",
  "volcano",
  "airplane",
  "butterfly",
  "kangaroo",
  "octopus",
  "calendar",
  "chocolate",
  "hospital",
  "library",
  "sandwich",
  "telescope",
];

export function natoMarker(runId, runAttempt) {
  const token = `${runId}-${runAttempt}`;
  if (!/^\d+-\d+$/.test(token)) throw new Error("run id and attempt must be numeric");
  let value = BigInt(`0x${createHash("sha256").update(token).digest("hex")}`);
  const available = [...SPEECH_WORDS];
  const marker = [];
  for (let count = 0; count < 3; count += 1) {
    const index = Number(value % BigInt(available.length));
    value /= BigInt(available.length);
    marker.push(available.splice(index, 1)[0]);
  }
  return marker.join(" ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runId, runAttempt] = process.argv.slice(2);
  if (!/^\d+$/.test(runId ?? "") || !/^\d+$/.test(runAttempt ?? "")) {
    throw new Error("usage: node scripts/nato-marker.mjs <numeric-run-id> <numeric-run-attempt>");
  }
  process.stdout.write(`${natoMarker(runId, runAttempt)}\n`);
}
