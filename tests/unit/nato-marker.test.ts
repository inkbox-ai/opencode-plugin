import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SPEECH_SAFE = new Set(
  "banana elephant pineapple alligator motorcycle umbrella dinosaur potato computer volcano airplane butterfly kangaroo octopus calendar chocolate hospital library sandwich telescope".split(
    " ",
  ),
);

function marker(runId: string, attempt: string): string[] {
  return execFileSync(process.execPath, ["scripts/nato-marker.mjs", runId, attempt], {
    encoding: "utf8",
  })
    .trim()
    .split(" ");
}

describe("hosted voice speech-safe marker", () => {
  it.each([
    ["0", "0"],
    ["1", "1"],
    ["676", "2"],
    ["999999999999", "9"],
  ])("produces five distinct speech-safe words for run %s attempt %s", (runId, attempt) => {
    const words = marker(runId, attempt);
    expect(words).toHaveLength(5);
    expect(new Set(words).size).toBe(5);
    expect(words.every((word) => SPEECH_SAFE.has(word))).toBe(true);
  });
});
