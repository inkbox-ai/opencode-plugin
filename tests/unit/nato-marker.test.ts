import { describe, expect, it } from "vitest";
// The production marker stays an executable .mjs helper for workflow use.
// @ts-expect-error JavaScript CLI modules do not ship TypeScript declarations.
import { natoMarker } from "../../scripts/nato-marker.mjs";

const SPEECH_WORDS = new Set(
  "banana elephant pineapple alligator motorcycle umbrella dinosaur potato computer volcano airplane butterfly kangaroo octopus calendar chocolate hospital library sandwich telescope".split(
    " ",
  ),
);

function marker(runId: string, attempt: string): string[] {
  return natoMarker(runId, attempt).split(" ");
}

describe("hosted voice marker", () => {
  it.each([
    ["0", "0"],
    ["1", "1"],
    ["676", "2"],
    ["999999999999", "9"],
  ])("produces three distinct speech-safe words for run %s attempt %s", (runId, attempt) => {
    const words = marker(runId, attempt);
    expect(words).toHaveLength(3);
    expect(new Set(words).size).toBe(3);
    expect(words.every((word) => SPEECH_WORDS.has(word))).toBe(true);
  });

  it("uses substantially more than trailing run-id digits", () => {
    const markers = new Set(
      Array.from({ length: 1_000 }, (_, index) =>
        marker(`3119602${index.toString().padStart(4, "0")}`, "1").join(" "),
      ),
    );
    expect(markers.size).toBeGreaterThanOrEqual(850);
  });
});
