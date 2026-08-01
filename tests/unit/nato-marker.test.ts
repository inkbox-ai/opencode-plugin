import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const NATO = new Set(
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(
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

describe("hosted voice NATO marker", () => {
  it.each([
    ["0", "0"],
    ["1", "1"],
    ["676", "2"],
    ["999999999999", "9"],
  ])("produces five distinct speech-safe words for run %s attempt %s", (runId, attempt) => {
    const words = marker(runId, attempt);
    expect(words).toHaveLength(5);
    expect(new Set(words).size).toBe(5);
    expect(words.every((word) => NATO.has(word))).toBe(true);
  });
});
