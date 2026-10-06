// Credential-free native protocol contract. The synthetic model only asks to
// read its working directory; the actual host raises and resolves permissions.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const [root, port] = process.argv.slice(2);
const packed = join(root, "node_modules/@inkbox/opencode-plugin/dist");
const load = (name) => import(pathToFileURL(join(packed, name)).href);
const [
  { subscribePermissionEvents },
  { createEscalationBridge },
  { createPendingReplies },
  { createStateStore },
] = await Promise.all([
  load("gateway/events.js"),
  load("gateway/escalation.js"),
  load("gateway/pending.js"),
  load("gateway/state.js"),
]);
const directory = join(root, "permission-handoff-contract");
mkdirSync(join(directory, ".git"), { recursive: true });
const holds = new Map();
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  for (const [marker, held] of holds) {
    if (body.messages.some((message) => JSON.stringify(message.content).includes(marker))) {
      held.seen = true;
      await held.promise;
    }
  }
  const completed = body.messages.some((message) => message.role === "tool");
  const delta = completed
    ? { role: "assistant", content: "Native permission contract completed." }
    : {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "native-permission-tool",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: "pwd",
                description: "Read the isolated working directory",
              }),
            },
          },
        ],
      };
  const finish = completed ? "stop" : "tool_calls";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "native-permission",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: delta, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (value, reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "native-permission", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
    );
  send(delta);
  send({}, finish);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
writeFileSync(
  join(directory, "opencode.json"),
  JSON.stringify({
    permission: { bash: "ask" },
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Native permission transport fixture",
        options: { baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: { "mock-model": { name: "mock-model" } },
      },
    },
  }),
);
const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const logger = { info() {}, warn() {}, error() {} };
const author = { sender: "T:OWNER", channel: "slack", route: "T:C:thread" };
async function until(predicate, detail) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Native permission contract timed out: ${detail}`);
}

const [
  { createSessionManager },
  { resolveConfig },
  { createNativePermissionInventory },
  { normalizePermission },
] = await Promise.all([
  load("gateway/sessions.js"),
  load("config.js"),
  load("gateway/permission-inventory.js"),
  load("gateway/events.js"),
]);
const config = resolveConfig(
  { identity: "synthetic", gateway: { model: "fixture/mock-model" } },
  {},
);
const identity = { id: "synthetic-identity", agentHandle: "synthetic" };
function hold(marker) {
  const held = { seen: false };
  held.promise = new Promise((resolve) => {
    held.release = resolve;
  });
  holds.set(marker, held);
  return held;
}
let submissions = 0;
const originalPrompt = client.session.promptAsync.bind(client.session);
client.session.promptAsync = (...args) => {
  submissions++;
  return originalPrompt(...args);
};
const readInventory = () =>
  createNativePermissionInventory(client).list(directory, AbortSignal.timeout(5000));
const sessionsToClean = new Set();
function gateway(state, options = {}) {
  let bridge;
  const relayed = [];
  const responses = [];
  const afterClaim = [];
  const pending = createPendingReplies();
  const native = Object.create(client);
  native.postSessionIdPermissionsPermissionId = async (args) => {
    const record = state.listPermissions().find((p) => p.permissionID === args.path.permissionID);
    assert.equal(record?.state, "responding");
    assert.equal(record.response, args.body.response);
    responses.push({ sessionID: args.path.id, response: args.body.response });
    if (options.beforePost) await options.beforePost(args);
    return client.postSessionIdPermissionsPermissionId(args);
  };
  const manager = createSessionManager({
    opencode: native,
    config,
    state,
    directory,
    logger,
    inkbox: { getIdentity: async () => identity },
    reconcilePermissions: async (force) => {
      if (force)
        afterClaim.push(
          state.listTurns().some((turn) => turn.ownerId && turn.leaseUntil > Date.now()),
        );
      await bridge?.reconcile(force);
    },
  });
  bridge = createEscalationBridge({
    opencode: native,
    state,
    directory,
    logger,
    timeoutMs: 30000,
    chatKeyForSession: (id) =>
      Object.entries(state.read().sessions).find(([, value]) => id === value)?.[0],
    resolveOwner: (request, signal) => manager.resolvePermissionOwner(request, signal),
    ownerCurrent: (owner) => manager.permissionOwnerCurrent(owner),
    inventory: async () => (await readInventory()).map(normalizePermission).filter(Boolean),
    relay: {
      ask: (key, text, _target, options) =>
        pending.ask(
          key,
          options.timeoutMs,
          author,
          async () => {
            relayed.push(key);
          },
          options.signal,
        ),
    },
  });
  const events = subscribePermissionEvents(native, bridge, logger, directory);
  return {
    manager,
    bridge,
    events,
    relayed,
    responses,
    afterClaim,
    pending,
    async close() {
      manager.freezeAdmission();
      await bridge.close();
      pending.close();
      events.close();
      await bridge.detach();
      await manager.close();
      for (const id of Object.values(state.read().sessions)) sessionsToClean.add(id);
    },
  };
}
try {
  // A prompt already executing before shutdown produces its ask while another
  // exact-owned rejection is held. No extra human relay and no lost request.
  const state = createStateStore(join(directory, "handoff-closing"));
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstSession,
    firstRejectHeld = false;
  const g = gateway(state, {
    beforePost: async (args) => {
      if (args.path.id === firstSession) {
        firstRejectHeld = true;
        await firstGate;
      }
    },
  });
  const first = g.manager.runText("first", "Read the isolated directory first.");
  void first.catch(() => {});
  await until(() => g.relayed.length === 1, "first real owned permission");
  firstSession = state.getSession("first");
  const held = hold("held-close-window");
  const second = g.manager.runText("second", "held-close-window: read the isolated directory.");
  void second.catch(() => {});
  await until(() => held.seen, "second native prompt executing before shutdown");
  g.manager.freezeAdmission();
  const closing = g.bridge.close();
  await until(() => firstRejectHeld, "first native reject held");
  held.release();
  await until(() => g.responses.length === 2, "late request durably rejected");
  assert.deepEqual(g.relayed, ["first"]);
  releaseFirst();
  await closing;
  g.events.close();
  g.pending.close();
  await g.bridge.detach();
  await g.manager.close();
  const owned = new Set(Object.values(state.read().sessions));
  assert.ok((await readInventory()).every((request) => !owned.has(request.sessionID)));
  assert.equal(state.listPermissions().length, 0);
  for (const id of owned) sessionsToClean.add(id);

  // A legitimately accepted native turn continues after local shutdown. Its
  // ask is emitted after SSE detaches, then a fresh manager must reclaim the
  // actual durable lease before inventory may relay it, without resubmission.
  const restartHome = join(directory, "handoff-detached");
  const original = createStateStore(restartHome);
  const old = gateway(original);
  const detached = hold("held-after-detach");
  const before = submissions;
  const accepted = old.manager.runText(
    "continued",
    "held-after-detach: read the isolated directory.",
  );
  void accepted.catch(() => {});
  await until(() => detached.seen, "accepted native turn before detach");
  const retained = original.listTurns()[0];
  assert.equal(retained.state, "submitted");
  await old.close();
  detached.release();
  await until(
    async () => (await readInventory()).some((request) => request.sessionID === retained.sessionID),
    "native ask after observer detach",
  );
  assert.equal(original.listPermissions().length, 0);
  const reopened = createStateStore(restartHome);
  const next = gateway(reopened);
  // A startup snapshot without a current local owner must not adopt the ask.
  await next.bridge.reconcile(true);
  assert.equal(next.relayed.length, 0);
  await next.manager.catchUp();
  await until(() => next.relayed.length === 1, "reclaimed turn inventory admission");
  assert.ok(next.afterClaim.includes(true));
  assert.deepEqual(next.relayed, ["continued"]);
  assert.equal(next.pending.tryConsume("continued", "1", author), true);
  await until(
    () => reopened.listTurns()[0].state === "completed",
    "native continuation without replay",
  );
  assert.equal(submissions - before, 1);
  assert.deepEqual(
    next.responses.map((entry) => entry.response),
    ["once"],
  );
  assert.equal(reopened.listPermissions().length, 0);
  assert.ok((await readInventory()).every((request) => request.sessionID !== retained.sessionID));
  await next.close();
  console.log(
    "PASS: packed native late-permission shutdown and exact-owner restart handoff contract",
  );
} finally {
  for (const held of holds.values()) held.release();
  for (const sessionID of sessionsToClean)
    await client.session.abort({ path: { id: sessionID }, query: { directory } });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
