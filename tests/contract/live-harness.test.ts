import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const liveAut = readFileSync("scripts/live-aut.sh", "utf8");
const liveChannels = readFileSync(".github/workflows/live-channels.yml", "utf8");
const liveVoice = readFileSync(".github/workflows/live-voice.yml", "utf8");

function shellCommands(source: string): string[] {
  return source.replace(/\\\n\s*/g, " ").split("\n");
}

function yamlJob(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return "";
  const nextJob = lines.findIndex((line, index) => index > start && /^ {2}\S[^:]*:$/.test(line));
  return lines.slice(start, nextJob < 0 ? undefined : nextJob).join("\n");
}

describe("live harness readiness bounds", () => {
  it("bounds both opencode /config readiness probes", () => {
    const configProbes = shellCommands(liveAut).filter(
      (command) => /\bcurl\b/.test(command) && command.includes("/config"),
    );
    const boundedConfigProbes = configProbes.filter((command) =>
      command.includes("curl -sf --connect-timeout 1 --max-time 3"),
    );

    expect(configProbes).toHaveLength(2);
    expect(boundedConfigProbes).toHaveLength(configProbes.length);
  });

  it("bounds the channel mock-model readiness probe", () => {
    const modelProbes = shellCommands(liveChannels).filter(
      (command) => /\bcurl\b/.test(command) && command.includes("/v1/models"),
    );
    const boundedModelProbes = modelProbes.filter((command) =>
      command.includes("curl -sf --connect-timeout 1 --max-time 3"),
    );

    expect(modelProbes).toHaveLength(1);
    expect(boundedModelProbes).toHaveLength(modelProbes.length);
  });

  it("caps the live-channel matrix job at twenty-five minutes", () => {
    const liveJob = yamlJob(liveChannels, "live");

    expect(liveJob).toContain("matrix:");
    expect(liveJob).toMatch(/^ {4}timeout-minutes: 25$/m);
  });

  it("caps every voice matrix job at fifteen minutes", () => {
    const voiceJob = yamlJob(liveVoice, "voice");

    expect(voiceJob).toContain("matrix:");
    expect(voiceJob).toMatch(/^ {4}timeout-minutes: 15$/m);
  });

  it("requires the hosted caller to persist and read back the exact SMS body", () => {
    expect(liveVoice).toContain(
      'export VOICE_DRIVER_LINE="After we hang up, send me one SMS containing these exact five words: $HOSTED_MARKER. Create one post-call action now. Set both the action title and the action details to this exact seven-word phrase: Send SMS $HOSTED_MARKER. Wait for the action tool to succeed, then read the exact five-word SMS body back to me. Do not paraphrase, omit a word, or send the SMS during the call."',
    );
  });

  it("preserves diagnostics when the voice job is cancelled by its timeout", () => {
    expect(liveVoice.match(/if: failure\(\) \|\| cancelled\(\)/g)).toHaveLength(2);
  });

  it("preserves diagnostics when the live-channel job is cancelled by its timeout", () => {
    expect(liveChannels.match(/if: failure\(\) \|\| cancelled\(\)/g)).toHaveLength(2);
  });
});
