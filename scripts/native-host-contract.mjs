// Synthetic transport fixture, not a model-capability test. Existing live
// model tasks remain separate. This exercises the packed gateway against the
// actual native host's session IDs, prompt submission, status and messages.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const [directory, port] = process.argv.slice(2);
if (!directory || !port) throw new Error("Expected an isolated project and host port.");
const packed = join(directory, "node_modules/@inkbox/opencode-plugin/dist");
const load = (name) => import(pathToFileURL(join(packed, name)).href);
const [{ createSessionManager }, { createStateStore }, { resolveConfig }] = await Promise.all([
  load("gateway/sessions.js"),
  load("gateway/state.js"),
  load("config.js"),
]);
process.env.INKBOX_OPENCODE_HOME = join(directory, "native-contract-state");
const state = createStateStore();
const opencode = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const sends = [],
  statuses = [],
  reactions = [];
const identity = {
  id: "synthetic-identity",
  agentHandle: "synthetic",
  imessageEnabled: true,
  sendIMessage: async (request) => {
    sends.push(request);
    return { id: `send-${sends.length}`, conversationId: request.conversationId };
  },
};
const slack = {
  listConnections: async () => ({
    connections: [
      { id: "connection", identityId: identity.id, workspaceId: "TWORKSPACE", status: "connected" },
    ],
  }),
  sendMessage: async (_connection, request) => {
    sends.push(request);
    return { id: `send-${sends.length}`, status: "sent" };
  },
  setProcessingStatus: async (...args) => {
    statuses.push(args);
    return { status: "succeeded" };
  },
  addReaction: async (...args) => {
    reactions.push(args);
    return { status: "succeeded" };
  },
  removeReaction: async () => ({ status: "succeeded" }),
};
const config = resolveConfig(
  {
    identity: "synthetic",
    baseUrl: "https://synthetic.invalid",
    gateway: { model: "mock/mock-model", slackEnabled: true, imessageThreadedReplies: true },
  },
  {},
);
const manager = createSessionManager({
  opencode,
  config,
  state,
  directory,
  inkbox: { getIdentity: async () => identity, getClient: async () => ({ slack }) },
  logger: {
    info() {},
    warn() {},
    error(message) {
      console.error(message);
    },
  },
});
async function until(predicate, detail) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Native host contract timed out: ${detail}; states=${JSON.stringify(state.listTurns().map((turn) => ({ state: turn.state, error: turn.error })))}`,
  );
}
try {
  const inbound = (messageId, text, threadId = null) => ({
    channel: "imessage",
    chatKey: "native-conversation",
    from: "+15550000001",
    conversationId: "conversation",
    messageId,
    imessageSource: { messageId, conversationId: "conversation", threadId },
    text,
    mediaPaths: [],
  });
  await manager.handleInbound(inbound("first", "smoke-aabbcc11"));
  await manager.handleInbound(inbound("fragment", "same thought"));
  await manager.handleInbound(inbound("next", "smoke-aabbcc22", "opaque-thread"));
  assert.equal(
    state.listTurns().length,
    2,
    "durable burst receipts must exist before acceptance returns",
  );
  await until(() => sends.length === 2, "serialized native replies");
  assert.deepEqual(
    sends.map((send) => send.replyToMessageId),
    ["first", "next"],
  );
  assert.ok(sends.every((send) => send.plainReplyFallback === true));
  assert.match(sends[0].text, /smoke-aabbcc11/);
  assert.match(sends[1].text, /smoke-aabbcc22/);
  assert.equal(
    new Set(state.listTurns().map((turn) => turn.sessionID)).size,
    1,
    "native thread IDs must not fork host sessions",
  );
  const route = {
    identityId: identity.id,
    connectionId: "connection",
    workspaceId: "TWORKSPACE",
    conversationId: "CROOM",
    actorId: "UPERSON",
    author: "TWORKSPACE:UPERSON",
    messageTs: "1770000000.000001",
    threadTs: "1770000000.000001",
    sourceEventId: "slack-source",
    mentioned: true,
    addressed: true,
    direct: false,
    rawText: "smoke-aabbcc33",
    text: "smoke-aabbcc33",
  };
  await manager.handleInbound({
    channel: "slack",
    slack: route,
    chatKey: "slack-scope",
    from: route.author,
    messageId: route.sourceEventId,
    conversationId: route.conversationId,
    text: route.text,
    mediaPaths: [],
    group: { participantCount: 2 },
  });
  await until(() => sends.length === 3, "Slack native thread reply");
  assert.equal(sends[2].threadTs, route.threadTs);
  assert.match(sends[2].text, /smoke-aabbcc33/);
  await manager.close();
  assert.ok(statuses.some((status) => status[3] === "processing"));
  assert.ok(statuses.some((status) => status[3] === "active"));
  assert.equal(reactions.length, 0, "native subthreads never use eyes");
  const sessionID = state.getSession("native-conversation");
  const abort = await opencode.session.abort({ path: { id: sessionID }, query: { directory } });
  assert.equal(abort.data, true, "native abort fencing requires a positive host acknowledgement");
  const status = await opencode.session.status({ query: { directory } });
  assert.equal(status.error, undefined);
  assert.equal(status.data?.[sessionID]?.type ?? "idle", "idle");
  console.log(
    "PASS: packed native session queue, first-source targets, Slack thread status, and abort/status contract",
  );
} finally {
  await manager.close();
}
