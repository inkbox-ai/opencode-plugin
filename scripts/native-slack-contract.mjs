// Real native host protocol + packed plugin code; synthetic provider boundary, no live sends.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const [directory, port, modelPort] = process.argv.slice(2);
const load = (name) =>
  import(pathToFileURL(join(directory, "node_modules/@inkbox/opencode-plugin/dist", name)).href);
const [{ createSessionManager }, { createStateStore }, { resolveConfig }] = await Promise.all([
  load("gateway/sessions.js"),
  load("gateway/state.js"),
  load("config.js"),
]);
const opencode = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const state = createStateStore(join(directory, "native-slack-state"));
process.env.INKBOX_OPENCODE_HOME = join(directory, "native-slack-state");
writeFileSync(join(directory, "chart.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const replies = [],
  progress = [],
  edits = [];
const operation = {
  id: "operation",
  status: "succeeded",
  messageTs: "2.0",
  connectionId: "connection",
  conversationId: "CROOM",
};
const slack = {
  listConnections: async () => ({
    connections: [
      {
        id: "connection",
        identityId: "synthetic-identity",
        workspaceId: "TWORKSPACE",
        status: "connected",
      },
    ],
  }),
  sendMessage: async (_connection, request) => {
    (request.text.includes("REPLY_OK") ? replies : progress).push(request);
    return { ...operation, status: "sent" };
  },
  updateMessage: async (...args) => {
    edits.push(args);
    return operation;
  },
  getAction: async () => ({ ...operation, status: "sent" }),
  getOperation: async () => operation,
  setProcessingStatus: async () => operation,
  addReaction: async () => operation,
  removeReaction: async () => operation,
};
const manager = createSessionManager({
  opencode,
  state,
  directory,
  config: resolveConfig(
    { identity: "synthetic", gateway: { model: "mock/mock-model", slackEnabled: true } },
    {},
  ),
  inkbox: {
    getIdentity: async () => ({ id: "synthetic-identity" }),
    getClient: async () => ({ slack }),
  },
  logger: {
    info() {},
    warn() {},
    error(message) {
      console.error(message);
    },
  },
});
async function until(check, label) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Native Slack contract timeout: ${label}; ${JSON.stringify(state.listTurns().map((turn) => ({ state: turn.state, error: turn.error })))}`,
  );
}
const route = {
  identityId: "synthetic-identity",
  connectionId: "connection",
  workspaceId: "TWORKSPACE",
  conversationId: "CROOM",
  actorId: "UPERSON",
  author: "TWORKSPACE:UPERSON",
  messageTs: "1.1",
  threadTs: "1.0",
  sourceEventId: "upload-source",
  addressed: true,
  mentioned: true,
  direct: false,
  text: "SLACK_UPLOAD_FIXTURE",
  rawText: "SLACK_UPLOAD_FIXTURE",
};
async function inbound(sourceEventId, text) {
  await manager.handleInbound({
    channel: "slack",
    chatKey: "slack-fixture",
    from: route.author,
    messageId: sourceEventId,
    conversationId: route.conversationId,
    text,
    slack: { ...route, sourceEventId, text, rawText: text },
    mediaPaths: [],
    group: { participantCount: 2 },
  });
}
try {
  await inbound("upload-source", "SLACK_UPLOAD_FIXTURE smoke-aabbcc44");
  await until(
    () => existsSync(join(directory, "slack-upload.json")) && replies.length === 1,
    "real tool context upload",
  );
  const upload = JSON.parse(readFileSync(join(directory, "slack-upload.json"), "utf8"));
  assert.equal(upload.contentBase64, "iVBORw0KGgo=");
  assert.equal(upload.threadTs, "1.0");
  assert.match(upload.idempotencyKey, /^opencode:upload:/);
  await until(() => edits.some((args) => args[3] === "Completed"), "terminal progress edit");
  assert.equal(progress.length, 1, "one coalesced progress message for the upload source");
  assert.ok(edits.every((args) => !/chart.png|call_slack_fixture|contentBase64/.test(args[3])));
  const messages = await opencode.session.messages({
    path: { id: state.getSession("slack-fixture") },
    query: { directory },
  });
  assert.ok(
    messages.data.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "inkbox_slack_upload_file" &&
          part.state.status === "completed",
      ),
    ),
    "host tool completed with real part/callID protocol",
  );
  await inbound("stop-source", "SLACK_STOP_FIXTURE");
  await until(
    () =>
      state
        .listTurns()
        .some(
          (turn) =>
            turn.replyTarget?.slack?.sourceEventId === "stop-source" && turn.state === "submitted",
        ),
    "held native turn",
  );
  // The fixture has begun a real SSE response. Older hosts do not persist a
  // partial text part until text-end, so do not infer startup from history text.
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`http://127.0.0.1:${modelPort}/fixture-state`);
    const fixture = await response.json();
    if (fixture.stopStreamsStarted > 0) break;
    if (attempt === 99)
      throw new Error(`Synthetic generation never began: ${JSON.stringify(fixture)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await manager.stopSlack({ ...route, sourceEventId: "stop-control" });
  const stopped = state
    .listTurns()
    .find((turn) => turn.replyTarget?.slack?.sourceEventId === "stop-source");
  assert.equal(stopped.executionFenced, true);
  assert.equal(stopped.state, "interrupted");
  await inbound("after-stop", "smoke-aabbcc55");
  await until(() => replies.length === 2, "follow-up after native Stop");
  assert.match(replies[1].text, /smoke-aabbcc55/);
  console.log(
    "PASS: packed native Slack upload call ownership, byte delivery, coalesced progress, and Stop-followup contract",
  );
} finally {
  await manager.close();
}
