import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/gateway/state.js";
import type { ReplyTarget } from "../../src/gateway/types.js";
import { nativeTarget, ownsNativeFailure, sendNativeIMessage } from "../../src/imessage-native.js";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "native-source-"));
  dirs.push(dir);
  return createStateStore(dir);
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("deduplicates an observed exact tool/automatic reply, but not unrelated output", async () => {
  const state = store(),
    identity: any = { id: "identity", sendIMessage: vi.fn(async () => ({ id: "sent" })) };
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
  const owned = await nativeTarget("session", "conversation", context, host, state);
  expect(owned).toEqual({ ...target, nativeOwner: { turnId: "turn", ownerId: "owner" } });
  expect(await nativeTarget("session", "other-conversation", context, host, state)).toBeUndefined();
  host.session.message.mockResolvedValueOnce({
    data: { info: { role: "assistant", parentID: "proactive-host-message" } },
  });
  expect(await nativeTarget("session", "conversation", context, host, state)).toBeUndefined();
  host.session.message.mockImplementationOnce(async () => {
    state.updateTurn("turn", { state: "interrupted" });
    return { data: { info: { role: "assistant", parentID: "source-host-message" } } };
  });
  await expect(nativeTarget("session", "conversation", context, host, state)).rejects.toThrow(
    "no longer owns",
  );
  const identity: any = { id: "identity", sendIMessage: vi.fn() };
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
        ? { messages: [], has_more: false, next_cursor: null, thread_id: "opaque-thread" }
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
