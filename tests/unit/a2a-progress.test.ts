import { describe, expect, it } from "vitest";
import {
  a2aActivityForTool,
  a2aActivityFromMessages,
  a2aProgressUserPrompt,
  cleanA2AProgress,
  clearA2AProgressDrain,
  fallbackA2AProgress,
  listA2AProgressDrains,
  MAX_PROGRESS_WORDS,
  requestA2AProgressDrain,
} from "../../src/a2a-progress.js";

describe("A2A progress summaries", () => {
  it("maps tool names to coarse activity without retaining inputs or results", () => {
    const messages = [
      { info: { id: "worker-message" }, parts: [{ type: "text", text: "private task" }] },
      {
        info: { id: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "run_sql_query",
            state: { input: { query: "private-value" }, output: "private-result" },
          },
          { type: "patch", files: ["private-file"] },
        ],
      },
    ];

    const activity = a2aActivityFromMessages(messages, "worker-message");

    expect(activity).toEqual(["checking the requested data", "making the requested changes"]);
    expect(JSON.stringify(activity)).not.toContain("private-value");
    expect(JSON.stringify(activity)).not.toContain("private-result");
    expect(JSON.stringify(activity)).not.toContain("private-file");
  });

  it("uses short deterministic fallbacks for recent activity", () => {
    expect(a2aActivityForTool("list_directory_users")).toBe("reviewing the requested records");
    expect(
      fallbackA2AProgress(["reviewing the requested records", "checking the requested data"]),
    ).toBe("I'm reviewing the requested records and checking the requested data.");
  });

  it("rejects terminal claims and enforces the word limit", () => {
    expect(cleanA2AProgress("Done — the task is complete.", ["validating the work"])).toBe(
      "I'm validating the work.",
    );
    const long = cleanA2AProgress(
      "I am carefully reviewing all requested records while checking data and preparing a concise detailed report for the requester now",
      ["reviewing the requested records"],
    );
    expect(long.split(" ")).toHaveLength(MAX_PROGRESS_WORDS);
    expect(long.endsWith("…")).toBe(true);
    for (const terminal of [
      "The final answer is ready.",
      "The task succeeded.",
      "Everything is resolved.",
      "I cannot complete the request.",
      "I'm waiting for input.",
    ]) {
      expect(cleanA2AProgress(terminal, ["validating the work"])).toBe("I'm validating the work.");
    }
  });

  it("passes only sanitized activity and the prior public update to the side model", () => {
    const prompt = a2aProgressUserPrompt(
      ["reviewing the relevant material", "validating the work"],
      "I'm reviewing the relevant material.",
    );

    expect(prompt).toContain("reviewing the relevant material; validating the work");
    expect(prompt).toContain("Previous update");
    expect(prompt).not.toContain("task text");
  });

  it("clears only the matching cross-process drain token", () => {
    const taskId = `task-${crypto.randomUUID()}`;
    const first = requestA2AProgressDrain(taskId);
    const second = requestA2AProgressDrain(taskId);

    clearA2AProgressDrain(taskId, first);

    expect(listA2AProgressDrains(taskId).map((request) => request.token)).toEqual([second]);
    clearA2AProgressDrain(taskId);
  });
});
