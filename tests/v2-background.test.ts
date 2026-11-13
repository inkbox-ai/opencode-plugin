import { describe, expect, it } from "vitest";
import { projectHistory } from "../src/host/v2-history.js";
import { nativeWork } from "../src/host/v2-work.js";

const input = { id: "input", type: "user", text: "start" };
const receipt = {
  id: "receipt",
  type: "assistant",
  finish: "tool-calls",
  content: [
    {
      type: "tool",
      name: "shell",
      id: "call",
      state: {
        status: "completed",
        metadata: { shellID: "shell-owned" },
        content: [
          { type: "text", text: "Command moved to the background (shell ID: shell-owned)." },
        ],
      },
    },
  ],
};
const answer = (id: string) => ({ id, type: "assistant", finish: "stop", content: [] });
const notice = {
  id: "notice",
  type: "synthetic",
  metadata: { source: "shell", shellID: "shell-owned" },
};

describe("native background ownership", () => {
  it("binds a matching native completion to its initiating source", () => {
    const history = projectHistory(
      [
        input,
        receipt,
        answer("initial"),
        { type: "idle", outcome: "succeeded" },
        notice,
        answer("followup"),
      ] as any,
      "session",
    );
    expect(history.messages.at(-1)?.info.parentID).toBe("input");
    expect(history.ambiguous).toBe(false);
  });
  it("leaves unrelated or overlapping notifications without inherited authority", () => {
    for (const extra of [
      [{ ...notice, metadata: { source: "shell", shellID: "other" } }],
      [{ ...input, id: "other-input" }, notice],
    ]) {
      const history = projectHistory(
        [input, receipt, answer("initial"), ...extra, answer("followup")] as any,
        "session",
      );
      expect(history.messages.at(-1)?.info.parentID).toBeUndefined();
    }
  });
  it("keeps an idle owner busy until producer notification and follow-up settle", async () => {
    let messages: any[] = [input, receipt, answer("initial")];
    let active = {};
    const client: any = {
      message: { list: async () => ({ data: messages, cursor: {} }) },
      shell: { list: async () => ({ data: [] }) },
      session: {
        list: async () => ({ data: [], cursor: {} }),
        active: async () => active,
        inbox: { list: async () => [] },
      },
    };
    expect((await nativeWork(client, "session", "/fixture")).busy).toBe(true);
    messages = [...messages, notice];
    active = { session: { type: "running" } };
    expect((await nativeWork(client, "session", "/fixture")).busy).toBe(true);
    active = {};
    messages.push(answer("followup"));
    expect((await nativeWork(client, "session", "/fixture")).busy).toBe(false);
  });
  it("tracks owned descendants without adopting another session's shell", async () => {
    const shell = { id: "owned", status: "running", metadata: { sessionID: "child" } };
    const client: any = {
      message: { list: async () => ({ data: [], cursor: {} }) },
      shell: {
        list: async () => ({
          data: [shell, { ...shell, id: "other", metadata: { sessionID: "unrelated" } }],
        }),
      },
      session: {
        list: async ({ parentID }: any) => ({
          data: parentID === "root" ? [{ id: "child" }] : [],
          cursor: {},
        }),
        active: async () => ({}),
        inbox: { list: async () => [] },
      },
    };
    const work = await nativeWork(client, "root", "/fixture");
    expect([...work.ids]).toEqual(["root", "child"]);
    expect(work.shells.map((item) => item.id)).toEqual(["owned"]);
    expect(work.busy).toBe(true);
  });
});
