import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const liveAut = readFileSync("scripts/live-aut.sh", "utf8");
const liveChannels = readFileSync(".github/workflows/live-channels.yml", "utf8");
const liveVoice = readFileSync(".github/workflows/live-voice.yml", "utf8");
const voiceDriver = readFileSync("tests/live/voice-driver.mjs", "utf8");
const liveStack = readFileSync(".github/workflows/live-stack.yml", "utf8");

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

  it("uses a natural hosted caller request without implementation coaching", () => {
    expect(liveVoice).toContain(
      'export VOICE_DRIVER_LINE="After we hang up, send me one SMS containing exactly these three words: $SPOKEN_MARKER. Please repeat the three words back so I know you heard them."',
    );
  });

  it("separates spoken words without changing the exact machine marker", () => {
    const spokenAssignment = liveVoice.match(/^ +SPOKEN_MARKER=.*$/m)?.[0];
    const lineAssignment = liveVoice.match(/^ +export VOICE_DRIVER_LINE=.*$/m)?.[0];
    expect(spokenAssignment).toBeDefined();
    expect(lineAssignment).toBeDefined();
    const result = execFileSync(
      "bash",
      [
        "-c",
        `${spokenAssignment}\n${lineAssignment}\nprintf '%s\\n%s' "$HOSTED_MARKER" "$VOICE_DRIVER_LINE"`,
      ],
      { env: { ...process.env, HOSTED_MARKER: "banana elephant pineapple" }, encoding: "utf8" },
    );
    const [machine, spoken] = result.split("\n");
    expect(machine).toBe("banana elephant pineapple");
    expect(spoken).toBe(
      "After we hang up, send me one SMS containing exactly these three words: banana, elephant, pineapple. Please repeat the three words back so I know you heard them.",
    );
  });

  it("does not tell real-model callers which tools or schema fields to use", () => {
    const a2a = readFileSync("tests/live/a2a_driver.py", "utf8");
    const voice = readFileSync("tests/live/voice.test.ts", "utf8");
    expect(a2a).not.toMatch(/inkbox_a2a_(?:call|check|reply|complete|ask_caller)/);
    expect(voice).not.toContain("Use inkbox_place_call");
    expect(voice).not.toContain("set voicemailDetection");
    expect(voice).not.toContain("record any post-call action");
    expect(liveVoice).not.toMatch(/export VOICE_DRIVER_LINE=.*(?:action|tool|title|details)/);
  });

  it("re-asks the hosted question while the agent is idle", () => {
    // The driver re-asks while the agent is idle and stops once it says the
    // marker back, so the marker has to reach the driver.
    expect(liveVoice).toContain('export VOICE_DRIVER_ANSWER_CONTAINS="$HOSTED_MARKER"');
    expect(voiceDriver).toContain("Date.now() - lastHeardAt >= QUIET_GAP_MS");
    expect(voiceDriver).toContain("reasks < MAX_REASKS");
    expect(voiceDriver).not.toContain("speak now if the greeting beat our timer");
  });

  it("keeps failure diagnostics content-free and out of public artifacts", () => {
    for (const workflow of [liveChannels, liveVoice]) {
      expect(workflow).toContain("Report content-free failure state");
      expect(workflow).not.toContain("actions/upload-artifact");
      expect(workflow).not.toMatch(/cat .*\.log/);
      expect(workflow).not.toMatch(/tail .*\.log/);
    }
  });

  it("runs the complete live matrix on PRs without canceling active cycles", () => {
    expect(liveStack).toContain("pull_request:");
    expect(liveStack).toContain("github.event_name == 'pull_request'");
    expect(liveStack).toContain("cancel-in-progress: false");
  });

  it("uses bounded retries only for npm setup", () => {
    for (const workflow of [liveChannels, liveVoice]) {
      expect(workflow).toContain('tests/ci/npm_with_retry.sh" ci');
      expect(workflow).toContain('tests/ci/npm_with_retry.sh" install');
    }
  });
});
