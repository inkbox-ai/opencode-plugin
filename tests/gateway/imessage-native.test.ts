import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/gateway/state.js";
import type { ReplyTarget } from "../../src/gateway/types.js";
import {
  nativeSource,
  noteNativeFailure,
  ownsNativeFailure,
  prepareNativeIMessage,
  sendNativeIMessage,
} from "../../src/imessage-native.js";
import { sendIMessageTools } from "../../src/tools/send-imessage.js";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "native-source-"));
  dirs.push(dir);
  return createStateStore(dir);
}
function nativeReads() {
  return {
    getIMessage: vi.fn(async () => ({ id: "source", conversationId: "conversation" })),
    getIMessageThread: vi.fn(async () => ({ conversationId: "conversation", messages: [] })),
  };
}
const target: ReplyTarget = {
  channel: "imessage",
  conversationId: "conversation",
  imessageSource: {
    messageId: "source",
    conversationId: "conversation",
    threadId: "opaque-thread",
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it.each(["missing-sdk", "source-conversation", "thread-conversation", "unsupported-endpoint"])(
  "rejects %s before recording or attempting a native send",
  async (failure) => {
    const state = store();
    const identity: any = { ...nativeReads(), id: "identity", sendIMessage: vi.fn() };
    if (failure === "missing-sdk") delete identity.getIMessageThread;
    if (failure === "source-conversation")
      identity.getIMessage.mockResolvedValue({ conversationId: "other" });
    if (failure === "thread-conversation")
      identity.getIMessageThread.mockResolvedValue({ conversationId: "other" });
    if (failure === "unsupported-endpoint")
      identity.getIMessageThread.mockRejectedValue(new Error("404 native endpoint unavailable"));
    await expect(sendNativeIMessage(identity, target, { text: "answer" }, state)).rejects.toThrow();
    expect(identity.sendIMessage).not.toHaveBeenCalled();
    expect(state.read().imessageSends ?? {}).toEqual({});
    if (failure === "source-conversation")
      expect(identity.getIMessageThread).not.toHaveBeenCalled();
  },
);
it("keeps transient native preflight safely retryable and probes only one thread item", async () => {
  const state = store();
  const identity: any = {
    ...nativeReads(),
    id: "identity",
    sendIMessage: vi.fn(async () => ({ id: "sent" })),
  };
  identity.getIMessageThread.mockRejectedValueOnce(new Error("503 unavailable"));
  await expect(
    prepareNativeIMessage(identity, target, { text: "saved answer" }, state),
  ).rejects.toThrow("503");
  expect(state.read().imessageSends ?? {}).toEqual({});
  const send = await prepareNativeIMessage(identity, target, { text: "saved answer" }, state);
  expect(identity.sendIMessage).not.toHaveBeenCalled();
  expect(identity.getIMessageThread).toHaveBeenLastCalledWith("source", { limit: 1 });
  await send();
  expect(identity.sendIMessage).toHaveBeenCalledOnce();
});
it.each(["source-read", "thread-read", "prepared-send"])(
  "rechecks native ownership after %s",
  async (boundary) => {
    const state = store();
    state.saveTurn({
      id: "turn",
      messageID: "input",
      sessionID: "session",
      chatKey: "chat",
      state: "submitted",
      kind: "normal",
      text: "question",
      deliver: true,
      replyTarget: target,
      ownerId: "owner",
      leaseUntil: Date.now() + 10000,
      createdAt: 1,
      updatedAt: 1,
    });
    const owned = { ...target, nativeOwner: { turnId: "turn", ownerId: "owner" } };
    const identity: any = { ...nativeReads(), id: "identity", sendIMessage: vi.fn() };
    if (boundary !== "prepared-send") {
      identity[
        boundary === "source-read" ? "getIMessage" : "getIMessageThread"
      ].mockImplementationOnce(async () => {
        state.updateTurn("turn", { state: "interrupted" });
        return { conversationId: "conversation" };
      });
      await expect(sendNativeIMessage(identity, owned, { text: "late" }, state)).rejects.toThrow(
        "no longer owns",
      );
    } else {
      const send = await prepareNativeIMessage(identity, owned, { text: "late" }, state);
      state.updateTurn("turn", { state: "interrupted" });
      await expect(send()).rejects.toThrow("no longer owns");
    }
    expect(identity.sendIMessage).not.toHaveBeenCalled();
    expect(state.read().imessageSends ?? {}).toEqual({});
  },
);
it("deduplicates an observed exact tool/automatic reply, but not unrelated output", async () => {
  const state = store(),
    identity: any = {
      ...nativeReads(),
      id: "identity",
      sendIMessage: vi.fn(async () => ({ id: "sent" })),
    };
  await sendNativeIMessage(identity, target, { text: "same answer" }, state);
  await sendNativeIMessage(identity, target, { text: "same answer" }, state);
  await sendNativeIMessage(identity, target, { text: "different answer" }, state);
  expect(identity.sendIMessage).toHaveBeenCalledTimes(2);
  expect(identity.sendIMessage.mock.calls[0][0]).toMatchObject({
    replyToMessageId: "source",
    plainReplyFallback: true,
    conversationId: "conversation",
  });
  expect(identity.sendIMessage.mock.calls[1][0].idempotencyKey).not.toBe(
    identity.sendIMessage.mock.calls[0][0].idempotencyKey,
  );
  expect(ownsNativeFailure("identity", "sent", undefined, state)).toBe(true);
});
it("checkpoints an uncertain effect before the call and never blindly retries it", async () => {
  const state = store();
  let observed = false;
  const identity: any = {
    ...nativeReads(),
    id: "identity",
    sendIMessage: vi.fn(async () => {
      observed = ownsNativeFailure("identity", undefined, "conversation", state);
      throw new Error("timeout after submission");
    }),
  };
  await expect(sendNativeIMessage(identity, target, { text: "answer" }, state)).rejects.toThrow(
    "timeout",
  );
  expect(observed).toBe(true);
  await expect(sendNativeIMessage(identity, target, { text: "answer" }, state)).rejects.toThrow(
    "unconfirmed",
  );
  expect(identity.sendIMessage).toHaveBeenCalledOnce();
});
it("binds tool targeting to the exact native parent and rejects stale owners", async () => {
  const state = store();
  state.saveTurn({
    id: "turn",
    messageID: "source-host-message",
    sessionID: "session",
    chatKey: "conversation",
    state: "submitted",
    kind: "normal",
    text: "question",
    deliver: true,
    replyTarget: target,
    ownerId: "owner",
    leaseUntil: Date.now() + 10000,
    createdAt: 1,
    updatedAt: 1,
  });
  const host: any = {
    session: {
      message: vi.fn(async () => ({
        data: { info: { role: "assistant", parentID: "source-host-message" } },
      })),
    },
  };
  const context = { messageID: "assistant-message", directory: "/synthetic" };
  const owned = await nativeSource("session", context, host, state);
  expect(owned).toEqual({ ...target, nativeOwner: { turnId: "turn", ownerId: "owner" } });
  host.session.message.mockResolvedValueOnce({ data: { info: { role: "assistant" } } });
  await expect(nativeSource("session", context, host, state)).rejects.toThrow(
    "parent is unavailable",
  );
  host.session.message.mockResolvedValueOnce({
    data: { info: { role: "assistant", parentID: "proactive-host-message" } },
  });
  expect(await nativeSource("session", context, host, state)).toBeUndefined();
  host.session.message.mockImplementationOnce(async () => {
    state.updateTurn("turn", { state: "interrupted" });
    return { data: { info: { role: "assistant", parentID: "source-host-message" } } };
  });
  await expect(nativeSource("session", context, host, state)).rejects.toThrow("no longer owns");
  const identity: any = { ...nativeReads(), id: "identity", sendIMessage: vi.fn() };
  await expect(sendNativeIMessage(identity, owned!, { text: "too late" }, state)).rejects.toThrow(
    "no longer owns",
  );
  expect(identity.sendIMessage).not.toHaveBeenCalled();
  expect(state.read().imessageSends ?? {}).toEqual({});
});
it("uses the published SDK native reply wire shape and opaque bounded thread reads", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body = String(url).includes("/thread")
        ? {
            conversation_id: "conversation",
            messages: [],
            has_more: false,
            next_cursor: null,
            thread_id: "opaque-thread",
          }
        : String(url).includes("/imessage/messages/source")
          ? { id: "source", conversation_id: "conversation", created_at: "2026-01-01" }
          : init?.method === "POST"
            ? {
                message: {
                  id: "sent",
                  conversation_id: "conversation",
                  status: "queued",
                  created_at: "2026-01-01",
                },
              }
            : {
                id: "identity",
                agent_handle: "synthetic",
                imessage_enabled: true,
                created_at: "2026-01-01",
              };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const sdk = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://sdk.test" });
  const identity = await sdk.getIdentity("synthetic");
  await sendNativeIMessage(identity, target, { text: "answer" }, store());
  const send = requests.find((request) => request.init?.method === "POST")!;
  expect(JSON.parse(String(send.init!.body))).toMatchObject({
    conversation_id: "conversation",
    reply_to_message_id: "source",
    plain_reply_fallback: true,
    text: "answer",
  });
  expect(new Headers(send.init!.headers).get("Idempotency-Key")).toMatch(/^opencode:native:/);
  await identity.getIMessageConversationThread("conversation", "opaque-thread", {
    limit: 20,
    cursor: "next",
  });
  expect(requests.at(-1)!.url).toContain("opaque-thread");
  expect(requests.at(-1)!.url).toContain("limit=20");
  expect(requests.at(-1)!.url).toContain("cursor=next");
});

it("retains callback-first and repeated failure as one quiet notice for its original source", async () => {
  const state = store();
  state.saveTurn({
    id: "owner",
    messageID: "host",
    chatKey: "original-chat",
    kind: "normal",
    state: "submitted",
    deliver: true,
    text: "request",
    replyTarget: target,
    createdAt: 1,
    updatedAt: 1,
  });
  const identity: any = {
    ...nativeReads(),
    id: "identity",
    sendIMessage: vi.fn(async () => {
      noteNativeFailure("identity", "sent", "conversation", state);
      return { id: "sent" };
    }),
  };
  await sendNativeIMessage(identity, target, { text: "answer" }, state);
  noteNativeFailure("identity", "sent", "conversation", state);
  noteNativeFailure("other-identity", "sent", "conversation", state);
  noteNativeFailure("identity", "unmatched-proactive", "other-conversation", state);
  const notices = state.listTurns().filter((turn) => turn.state === "context_only");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ chatKey: "original-chat", deliver: false, kind: "capture" });
  expect(notices[0].text).toContain("not a new request");
  expect(identity.sendIMessage).toHaveBeenCalledOnce();
});

it.each([
  "other-conversation",
  "recipient",
  "stale",
  "approval-cancel",
  "disabled",
  "valid",
  "proactive",
  "recipient-stale",
  "recipient-approval-cancel",
  "recipient-upload-cancel",
  "recipient-disabled",
  "recipient-disable-during-upload",
  "recipient-allowlist-denied",
  "final-preflight-disable",
  "final-preflight-cancel",
])("checks native %s ownership before approval, media upload and sending", async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "native-tool-effect-"));
  dirs.push(dir);
  vi.stubEnv("INKBOX_OPENCODE_HOME", dir);
  const state = createStateStore();
  state.saveTurn({
    id: "turn",
    messageID: "input",
    sessionID: "session",
    chatKey: "chat",
    kind: "normal",
    state: scenario.endsWith("stale") ? "interrupted" : "submitted",
    text: "question",
    deliver: true,
    replyTarget: target,
    ownerId: "owner",
    leaseUntil: Date.now() + 10000,
    createdAt: 1,
    updatedAt: 1,
  });
  const config = {
    gateway: { imessageThreadedReplies: !scenario.endsWith("disabled") },
    outbound: {
      allowedRecipients: scenario === "recipient-allowlist-denied" ? ["+14155550999"] : [],
      approval: "ask",
      askTimeoutMs: 0,
    },
  };
  const identity = {
    ...nativeReads(),
    id: "identity",
    uploadIMessageMedia: vi.fn(async () => {
      if (scenario === "recipient-upload-cancel")
        state.updateTurn("turn", { state: "interrupted" });
      if (scenario === "recipient-disable-during-upload")
        config.gateway.imessageThreadedReplies = false;
      return { mediaUrl: "https://media.example/synthetic.png" };
    }),
    sendIMessage: vi.fn(async (_input: any) => ({
      id: "sent",
      conversationId: "conversation",
      status: "sent",
    })),
  };
  let releaseProbe!: () => void, enterProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    enterProbe = resolve;
  });
  const probeHeld = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let threadReads = 0;
  identity.getIMessageThread.mockImplementation(async () => {
    if (++threadReads === 2 && scenario.startsWith("final-preflight")) {
      enterProbe();
      await probeHeld;
    }
    return { conversationId: "conversation", messages: [] };
  });
  const host = {
    session: {
      message: vi.fn(async () => ({
        data: {
          info: {
            role: "assistant",
            parentID: scenario === "proactive" ? "unrelated-input" : "input",
          },
        },
      })),
    },
  };
  const ask = vi.fn(async () => {
    if (scenario.endsWith("approval-cancel")) state.updateTurn("turn", { state: "interrupted" });
  });
  const tool = sendIMessageTools({
    runtime: { getIdentity: async () => identity },
    opencode: host,
    config,
  } as any)[0]!;
  const file = join(dir, "synthetic.png");
  writeFileSync(file, "synthetic-image");
  const args = {
    ...(scenario.startsWith("recipient") || scenario === "proactive"
      ? { to: "+14155550123" }
      : { conversationId: scenario === "other-conversation" ? "other" : "conversation" }),
    text: "answer",
    mediaPaths: [file],
  };
  const result = tool.definition.execute(args, {
    sessionID: "session",
    messageID: "assistant",
    directory: "/synthetic",
    ask,
    abort: new AbortController().signal,
  } as any);
  if (scenario.startsWith("final-preflight")) {
    await probeStarted;
    if (scenario === "final-preflight-disable") config.gateway.imessageThreadedReplies = false;
    else state.updateTurn("turn", { state: "interrupted" });
    releaseProbe();
  }
  if (["valid", "proactive", "recipient", "other-conversation"].includes(scenario)) {
    await result;
    expect(identity.uploadIMessageMedia).toHaveBeenCalledOnce();
    expect(identity.sendIMessage).toHaveBeenCalledOnce();
    expect(identity.sendIMessage.mock.calls[0]![0]).toMatchObject(
      scenario === "valid"
        ? { conversationId: "conversation", replyToMessageId: "source", plainReplyFallback: true }
        : scenario === "other-conversation"
          ? { conversationId: "other" }
          : { to: "+14155550123" },
    );
    if (scenario !== "valid") {
      expect(identity.sendIMessage.mock.calls[0]![0]).not.toHaveProperty("replyToMessageId");
      expect(identity.sendIMessage.mock.calls[0]![0]).not.toHaveProperty("plainReplyFallback");
      expect(identity.sendIMessage.mock.calls[0]![0]).not.toHaveProperty("idempotencyKey");
      expect(identity.getIMessage).not.toHaveBeenCalled();
      expect(state.read().imessageSends ?? {}).toEqual({});
      // An independent send cannot consume or deduplicate the source answer,
      // even when its text is identical to that later automatic answer.
      await sendNativeIMessage(identity as any, target, { text: "answer" }, state);
      expect(identity.sendIMessage).toHaveBeenCalledTimes(2);
      expect(identity.sendIMessage.mock.calls[1]![0]).toMatchObject({
        conversationId: "conversation",
        replyToMessageId: "source",
        plainReplyFallback: true,
      });
    }
  } else {
    await expect(result).rejects.toThrow(
      scenario === "recipient-allowlist-denied"
        ? "allowlist"
        : scenario.includes("disable")
          ? "disabled"
          : "no longer owns",
    );
    const afterUpload =
      scenario.startsWith("final-preflight") ||
      ["recipient-upload-cancel", "recipient-disable-during-upload"].includes(scenario);
    expect(identity.uploadIMessageMedia).toHaveBeenCalledTimes(afterUpload ? 1 : 0);
    expect(identity.sendIMessage).not.toHaveBeenCalled();
    expect(state.read().imessageSends ?? {}).toEqual({});
    expect(ask).toHaveBeenCalledTimes(scenario.endsWith("approval-cancel") || afterUpload ? 1 : 0);
  }
});
