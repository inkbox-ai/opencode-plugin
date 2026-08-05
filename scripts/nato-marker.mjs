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
  let value = BigInt(runId) * 10n + BigInt(runAttempt);
  const used = new Set();
  const marker = [];
  for (let count = 0; count < 5; count += 1) {
    let index = Number(value % BigInt(SPEECH_WORDS.length));
    value /= BigInt(SPEECH_WORDS.length);
    while (used.has(index)) index = (index + 1) % SPEECH_WORDS.length;
    used.add(index);
    marker.push(SPEECH_WORDS[index]);
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
