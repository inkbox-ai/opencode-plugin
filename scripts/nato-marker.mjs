import { pathToFileURL } from "node:url";

const RADIO_WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
];

export function natoMarker(runId, runAttempt) {
  let value = BigInt(runId) * 10n + BigInt(runAttempt);
  const used = new Set();
  const marker = [];
  for (let count = 0; count < 6; count += 1) {
    let index = Number(value % BigInt(RADIO_WORDS.length));
    value /= BigInt(RADIO_WORDS.length);
    while (used.has(index)) index = (index + 1) % RADIO_WORDS.length;
    used.add(index);
    marker.push(RADIO_WORDS[index]);
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
