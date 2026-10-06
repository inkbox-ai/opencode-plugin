import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createStateStore, type DurableTurn } from "../../src/gateway/state.js";
import { imessageReadTools } from "../../src/tools/imessage-reads.js";
import type { ToolDeps } from "../../src/tools/types.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected tool/request is missing");
  return value;
}
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "imessage-read-owner-"));
  vi.stubEnv("INKBOX_OPENCODE_HOME", directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const context = { sessionID: "session", messageID: "assistant", directory: "/project" } as any;
function setup(patch: Partial<DurableTurn> = {}) {
  const state = createStateStore();
  state.saveTurn({
    id: "turn",
    messageID: "host-input",
    sessionID: "session",
    chatKey: "chat",
    kind: "normal",
    state: "submitted",
    text: "read this thread",
    deliver: true,
    ownerId: "owner",
    leaseUntil: Date.now() + 10000,
    createdAt: 1,
    updatedAt: 1,
    replyTarget: {
      channel: "imessage",
      imessageSource: { messageId: "source", conversationId: "conversation" },
    },
    ...patch,
  });
  const identity = {
    getIMessage: vi.fn(async () => ({ id: "visible", conversationId: "conversation" })),
    getIMessageThread: vi.fn(async () => ({ messages: [], nextCursor: null })),
    getIMessageConversationThread: vi.fn(async () => ({ messages: [], nextCursor: null })),
  };
  const host = {
    session: {
      message: vi.fn(async () => ({
        data: { info: { role: "assistant", parentID: "host-input" } },
      })),
    },
  };
  const deps = {
    runtime: { getIdentity: vi.fn(async () => identity) },
    opencode: host,
    config: { gateway: { imessageThreadedReplies: true } },
    vault: {},
  } as unknown as ToolDeps;
  const tools = imessageReadTools(deps);
  return {
    state,
    identity,
    host,
    deps,
    byMessage: required(tools.find((tool) => tool.name === "inkbox_get_imessage_thread"))
      .definition,
    byConversation: required(
      tools.find((tool) => tool.name === "inkbox_get_imessage_conversation_thread"),
    ).definition,
  };
}

it("validates visible message conversation before reading the bounded native thread", async () => {
  const { identity, host, byMessage } = setup();
  await byMessage.execute({ messageId: "visible", limit: 100, cursor: "opaque-cursor" }, context);
  expect(host.session.message).toHaveBeenCalledWith({
    path: { id: "session", messageID: "assistant" },
    query: { directory: "/project" },
  });
  expect(identity.getIMessage).toHaveBeenCalledWith("visible");
  expect(identity.getIMessageThread).toHaveBeenCalledWith("visible", {
    limit: 100,
    cursor: "opaque-cursor",
  });
  expect(z.object(byMessage.args).safeParse({ messageId: "visible", limit: 101 }).success).toBe(
    false,
  );
  expect(z.object(byMessage.args).safeParse({ messageId: "visible", limit: 0 }).success).toBe(
    false,
  );
});

it("rejects cross-conversation message and conversation reads before thread retrieval", async () => {
  const { identity, byMessage, byConversation } = setup();
  identity.getIMessage.mockResolvedValueOnce({ id: "other-message", conversationId: "other" });
  await expect(byMessage.execute({ messageId: "other-message" }, context)).rejects.toThrow(
    "active source conversation",
  );
  await expect(
    byConversation.execute({ conversationId: "other", threadId: "opaque" }, context),
  ).rejects.toThrow("active source conversation");
  expect(identity.getIMessageThread).not.toHaveBeenCalled();
  expect(identity.getIMessageConversationThread).not.toHaveBeenCalled();
});

it("fails closed when a visible message lacks conversation evidence", async () => {
  const { identity, byMessage } = setup();
  identity.getIMessage.mockResolvedValueOnce({ id: "visible" } as any);
  await expect(byMessage.execute({ messageId: "visible" }, context)).rejects.toThrow(
    "active source conversation",
  );
  expect(identity.getIMessageThread).not.toHaveBeenCalled();
});

it.each(["companionMode", "companion"])("never expands %s history", async (marker) => {
  const fixture = setup();
  fixture.state.updateTurn(
    "turn",
    marker === "companionMode"
      ? { replyTarget: { channel: "imessage", companionMode: true } }
      : { companion: { metadata: { channel: "imessage" } } as any },
  );
  await expect(fixture.byMessage.execute({ messageId: "visible" }, context)).rejects.toThrow(
    "supplied Companion history",
  );
  await expect(
    fixture.byConversation.execute({ conversationId: "conversation", threadId: "opaque" }, context),
  ).rejects.toThrow("supplied Companion history");
  expect(fixture.identity.getIMessage).not.toHaveBeenCalled();
  expect(fixture.identity.getIMessageThread).not.toHaveBeenCalled();
  expect(fixture.identity.getIMessageConversationThread).not.toHaveBeenCalled();
});

it.each(["interrupted", "expired", "replaced"])(
  "rejects %s ownership after native parent lookup",
  async (change) => {
    const { state, host, identity, byMessage } = setup();
    host.session.message.mockImplementationOnce(async () => {
      state.updateTurn(
        "turn",
        change === "interrupted"
          ? { state: "interrupted" }
          : change === "expired"
            ? { leaseUntil: Date.now() - 1 }
            : { ownerId: "replacement" },
      );
      return { data: { info: { role: "assistant", parentID: "host-input" } } };
    });
    await expect(byMessage.execute({ messageId: "visible" }, context)).rejects.toThrow(
      "no longer owns",
    );
    expect(identity.getIMessage).not.toHaveBeenCalled();
    expect(identity.getIMessageThread).not.toHaveBeenCalled();
  },
);

it("rechecks ownership after the source lookup and before returning fetched history", async () => {
  const { state, identity, byMessage, byConversation } = setup();
  identity.getIMessage.mockImplementationOnce(async () => {
    state.updateTurn("turn", { state: "interrupted" });
    return { id: "visible", conversationId: "conversation" };
  });
  await expect(byMessage.execute({ messageId: "visible" }, context)).rejects.toThrow(
    "no longer owns",
  );
  expect(identity.getIMessageThread).not.toHaveBeenCalled();
  state.updateTurn("turn", { state: "submitted" });
  identity.getIMessageConversationThread.mockImplementationOnce(async () => {
    state.updateTurn("turn", { state: "interrupted" });
    return { messages: [], nextCursor: null };
  });
  await expect(
    byConversation.execute({ conversationId: "conversation", threadId: "opaque" }, context),
  ).rejects.toThrow("no longer owns");
});

it("does not inherit an old source for an unrelated proactive assistant parent", async () => {
  const { host, identity, byConversation } = setup({ state: "delivered" });
  host.session.message.mockResolvedValueOnce({
    data: { info: { role: "assistant", parentID: "proactive-input" } },
  });
  await byConversation.execute(
    { conversationId: "another-visible-conversation", threadId: "opaque-native-id", limit: 1 },
    context,
  );
  expect(identity.getIMessageConversationThread).toHaveBeenCalledWith(
    "another-visible-conversation",
    "opaque-native-id",
    { limit: 1, cursor: undefined },
  );
});

it("uses the actual published SDK identity-scoped message and thread request shapes", async () => {
  const fixture = setup();
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input));
      requests.push(url);
      const body =
        url.pathname.includes("/threads/") || url.pathname.endsWith("/thread")
          ? { messages: [], thread_id: "opaque-native-id", has_more: false, next_cursor: null }
          : url.pathname.endsWith("/messages/visible")
            ? {
                id: "visible",
                conversation_id: "conversation",
                status: "received",
                created_at: "2026-01-01",
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
  fixture.deps.runtime.getIdentity = vi.fn(async () => identity);
  const tools = imessageReadTools(fixture.deps);
  await required(
    tools.find((tool) => tool.name === "inkbox_get_imessage_thread"),
  ).definition.execute({ messageId: "visible", limit: 2 }, context);
  await required(
    tools.find((tool) => tool.name === "inkbox_get_imessage_conversation_thread"),
  ).definition.execute(
    { conversationId: "conversation", threadId: "opaque-native-id", limit: 100, cursor: "next" },
    context,
  );
  const message = required(requests.find((url) => url.pathname.endsWith("/messages/visible")));
  expect(message.searchParams.get("agent_identity_id")).toBe("identity");
  const thread = required(
    requests.find((url) => url.pathname.endsWith("/messages/visible/thread")),
  );
  expect(thread.searchParams.get("agent_identity_id")).toBe("identity");
  expect(thread.searchParams.get("limit")).toBe("2");
  expect(required(requests.at(-1)).pathname).toContain(
    "/conversations/conversation/threads/opaque-native-id",
  );
  expect(required(requests.at(-1)).searchParams.get("limit")).toBe("100");
  expect(required(requests.at(-1)).searchParams.get("cursor")).toBe("next");
});

it("does not treat a missing native parent as a proactive turn", async () => {
  const { host, identity, byMessage } = setup();
  host.session.message.mockResolvedValueOnce({ data: { info: { role: "assistant" } } } as any);
  await expect(byMessage.execute({ messageId: "visible" }, context)).rejects.toThrow(
    "parent is unavailable",
  );
  expect(identity.getIMessage).not.toHaveBeenCalled();
  expect(identity.getIMessageThread).not.toHaveBeenCalled();
});
