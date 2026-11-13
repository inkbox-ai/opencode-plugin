import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMcp, type RemoteToolResult } from "@inkbox/sdk/remote-mcp";
import { afterEach, expect, it } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import type { DurableTurn } from "../../src/gateway/state.js";
import { replyState, sendTerminalReply } from "../../src/terminal-reply.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "inkbox-terminal-"));
  roots.push(stateDir);
  const remote = new RemoteMcp({
    apiKey: "synthetic",
    baseUrl: "https://example.test",
    identity: "synthetic",
    journalPath: join(stateDir, "calls"),
  });
  const runtime = {
    config: { stateDir },
    getClient: async () => ({ _apiKey: "synthetic", _baseUrl: "https://example.test" }),
    getIdentity: async () => ({ id: "synthetic" }),
  } as unknown as InkboxRuntime;
  const event: DurableTurn = {
    id: "event",
    messageID: "message",
    chatKey: "route",
    state: "submitted",
    kind: "normal",
    text: "",
    deliver: true,
    createdAt: 1,
    updatedAt: 1,
    replyTarget: { channel: "sms", to: "+15550000001" },
  };

  return { remote, runtime, event, stateDir };
}

it("reconciles the same terminal operation and keeps unrelated sources independent", async () => {
  const { remote, runtime, event, stateDir } = await setup();
  const calls: string[] = [];
  const execute = async (
    _name: string,
    _args: Record<string, unknown>,
    operation: string,
    _journal: string,
    submit: () => Promise<void>,
  ): Promise<RemoteToolResult> => {
    await submit();
    calls.push(operation);
    if (calls.length === 1) throw new Error("Synthetic lost response");
    return {
      content: [],
      structuredContent: {
        message_id: "accepted",
        delivery_status: "sent",
        recipients: ["+15550000001"],
      },
    };
  };
  await expect(
    sendTerminalReply(remote, runtime, event, "Finished", async () => {}, stateDir, execute),
  ).rejects.toThrow("lost response");
  expect(await replyState(runtime, event, stateDir)).toBe("uncertain");
  await expect(
    sendTerminalReply(remote, runtime, event, "Changed", async () => {}, stateDir, execute),
  ).rejects.toThrow();
  await sendTerminalReply(remote, runtime, event, "Finished", async () => {}, stateDir, execute);
  expect(calls[0]).toBe(calls[1]);
  expect(await replyState(runtime, event, stateDir)).toBe("accepted");
  await sendTerminalReply(remote, runtime, event, "Finished", async () => {}, stateDir, execute);
  expect(calls).toHaveLength(2);
  expect(await replyState(runtime, { ...event, id: "another" }, stateDir)).toBe("none");
});

it("permits a different operation after rejection before execution", async () => {
  const { remote, runtime, event, stateDir } = await setup();
  const rejected = async (): Promise<RemoteToolResult> => ({ content: [], isError: true });
  await sendTerminalReply(remote, runtime, event, "First", async () => {}, stateDir, rejected);
  expect(await replyState(runtime, event, stateDir)).toBe("none");
  const accepted = async (
    _name: string,
    _args: Record<string, unknown>,
    _operation: string,
    _journal: string,
    submit: () => Promise<void>,
  ): Promise<RemoteToolResult> => {
    await submit();
    return {
      content: [],
      structuredContent: {
        message_id: "accepted",
        delivery_status: "sent",
        recipients: ["+15550000001"],
      },
    };
  };
  await sendTerminalReply(remote, runtime, event, "Second", async () => {}, stateDir, accepted);
  expect(await replyState(runtime, event, stateDir)).toBe("accepted");
});

it.each([
  { delivery_status: "blocked_spam_filter" },
  { delivery_status: "sending_failed" },
  { message_id: "" },
  { recipients: ["+15550000002"] },
  { error: "synthetic_failure" },
])("requires canonical accepted SMS receipt %j", async (changes) => {
  const { remote, runtime, event, stateDir } = await setup();
  const execute = async (
    _name: string,
    _args: Record<string, unknown>,
    _operation: string,
    _path: string,
    submit: () => void | Promise<void>,
  ): Promise<RemoteToolResult> => {
    await submit();
    return {
      content: [],
      structuredContent: {
        message_id: "accepted",
        recipients: ["+15550000001"],
        delivery_status: "queued",
        ...changes,
      },
    };
  };
  await expect(
    sendTerminalReply(remote, runtime, event, "Finished", async () => {}, stateDir, execute),
  ).rejects.toThrow();
  expect(await replyState(runtime, event, stateDir)).toBe("uncertain");
});
