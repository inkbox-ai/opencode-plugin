import { describe, expect, it } from "vitest";
import {
  a2aProgressUserPrompt,
  a2aToolIdentifiersFromMessages,
  cleanA2AProgress,
  clearA2AProgressDrain,
  fallbackA2AProgress,
  listA2AProgressDrains,
  MAX_PROGRESS_WORDS,
  normalizeA2AToolIdentifier,
  requestA2AProgressDrain,
} from "../../src/a2a-progress.js";

describe("A2A progress summaries", () => {
  it("keeps bounded normalized tool identifiers without retaining inputs or results", () => {
    const messages = [
      { info: { id: "worker-message" }, parts: [{ type: "text", text: "private task" }] },
      {
        info: { id: "assistant" },
        parts: [
          {
            type: "tool",
            tool: " Run SQL Query ",
            state: { input: { query: "private-value" }, output: "private-result" },
          },
          { type: "patch", files: ["private-file"] },
          ...Array.from({ length: 10 }, (_, index) => ({
            type: "tool",
            tool: `Tool ${index} ${"x".repeat(100)}`,
          })),
        ],
      },
    ];

    const identifiers = a2aToolIdentifiersFromMessages(messages, "worker-message");

    expect(identifiers).toHaveLength(8);
    expect(identifiers.every((identifier) => identifier.length <= 80)).toBe(true);
    expect(JSON.stringify(identifiers)).not.toContain("private-value");
    expect(JSON.stringify(identifiers)).not.toContain("private-result");
    expect(JSON.stringify(identifiers)).not.toContain("private-file");
  });

  it("normalizes identifiers and uses one generic fallback", () => {
    expect(normalizeA2AToolIdentifier(" List Directory Users ")).toBe("list_directory_users");
    expect(normalizeA2AToolIdentifier("run/sql query\n")).toBe("run_sql_query");
    expect(fallbackA2AProgress()).toBe("I'm continuing the requested work.");
  });

  it("rejects terminal claims and identifier echoes and enforces the word limit", () => {
    expect(cleanA2AProgress("Done — the task is complete.", ["run_tests"])).toBe(
      "I'm continuing the requested work.",
    );
    expect(cleanA2AProgress("I'm using run tests to verify behavior.", ["run_tests"])).toBe(
      "I'm continuing the requested work.",
    );
    expect(
      cleanA2AProgress(
        `I'm carefully reviewing the requested calculation and its supporting context ${"x".repeat(80)} run tests.`,
        ["run_tests"],
      ),
    ).toBe("I'm continuing the requested work.");
    const long = cleanA2AProgress(
      "I am carefully reviewing all requested records while checking data and preparing a concise detailed report for the requester now",
      ["list_directory_users"],
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
      expect(cleanA2AProgress(terminal, ["run_tests"])).toBe("I'm continuing the requested work.");
    }
  });

  it("passes bounded task context, identifiers, and the prior public update to the side model", () => {
    const prompt = a2aProgressUserPrompt(
      `Review the requested records. ${"x".repeat(2_100)}`,
      ["list_directory_users", "run_sql_query"],
      "I'm reviewing the records.",
    );

    expect(prompt).toContain("Review the requested records.");
    expect(prompt).toContain("list_directory_users; run_sql_query");
    expect(prompt).toContain("Previous update");
    expect(prompt.length).toBeLessThan(2_500);
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
