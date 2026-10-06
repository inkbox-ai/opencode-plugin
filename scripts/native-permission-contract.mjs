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
const directory = join(root, "permission-contract");
mkdirSync(join(directory, ".git"), { recursive: true });
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
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
let allReconnects = 0;
try {
  for (const mode of ["allow", "timeout", "delivery-failure", "externally-resolved", "shutdown"]) {
    const state = createStateStore(join(directory, `state-${mode}`));
    const created = await client.session.create({
      query: { directory },
      body: { title: `Synthetic ${mode}` },
    });
    assert.equal(created.error, undefined);
    const sessionID = created.data.id;
    state.setSession("owned-chat", sessionID);
    const pending = createPendingReplies();
    const relayed = [];
    const responses = [];
    let firstStream = mode === "allow";
    let subscriptions = 0;
    const native = {
      postSessionIdPermissionsPermissionId: async (args) => {
        responses.push(args.body.response);
        return client.postSessionIdPermissionsPermissionId(args);
      },
      event: {
        subscribe: async (args) => {
          subscriptions++;
          const actual = await client.event.subscribe(args);
          if (!firstStream) return actual;
          firstStream = false;
          return {
            stream: (async function* () {
              for await (const event of actual.stream) {
                yield event;
                break;
              }
            })(),
          };
        },
      },
    };
    const escalation = createEscalationBridge({
      opencode: native,
      state,
      logger,
      directory,
      timeoutMs: mode === "timeout" ? 100 : 30000,
      chatKeyForSession: (id) => (id === sessionID ? "owned-chat" : undefined),
      relay: {
        ask: (key, prompt, _target, options) =>
          pending.ask(
            key,
            options.timeoutMs,
            author,
            async () => {
              relayed.push(prompt);
              if (mode === "delivery-failure") throw new Error("Synthetic delivery rejected");
            },
            options.signal,
          ),
      },
    });
    const events = subscribePermissionEvents(native, escalation, logger, directory);
    try {
      if (mode === "allow") await until(() => subscriptions === 2, "native SSE reconnect");
      const submitted = await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          model: { providerID: "fixture", modelID: "mock-model" },
          parts: [{ type: "text", text: "Read this isolated working directory exactly once." }],
        },
      });
      assert.equal(submitted.error, undefined);
      await until(() => relayed.length === 1, `${mode} native permission relay`);
      assert.match(relayed[0], /Permission needed: bash: pwd/);
      if (mode === "allow") {
        assert.equal(
          pending.tryConsume("owned-chat", "1", { ...author, sender: "T:BYSTANDER" }),
          false,
        );
        assert.equal(
          pending.tryConsume("owned-chat", "1", { ...author, route: "T:C:elsewhere" }),
          false,
        );
        assert.equal(responses.length, 0);
        assert.equal(pending.tryConsume("owned-chat", "1", author), true);
      } else if (mode === "externally-resolved") {
        const permission = state.listPermissions()[0];
        const reply = await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionID, permissionID: permission.permissionID },
          query: { directory },
          body: { response: "reject" },
        });
        assert.equal(reply.error, undefined);
        assert.equal(reply.data, true);
      } else if (mode === "shutdown") {
        await escalation.close();
        pending.close();
        events.close();
        const aborted = await client.session.abort({
          path: { id: sessionID },
          query: { directory },
        });
        assert.equal(aborted.data, true);
        assert.equal(pending.pending("owned-chat"), false);
        assert.deepEqual(responses, ["reject"]);
        const outstanding = await fetch(
          `http://127.0.0.1:${port}/permission?directory=${encodeURIComponent(directory)}`,
        ).then((response) => response.json());
        assert.ok(Array.isArray(outstanding));
        assert.ok(outstanding.every((request) => request.sessionID !== sessionID));
        const status = await client.session.status({ query: { directory } });
        assert.equal(status.data?.[sessionID]?.type ?? "idle", "idle");
        continue;
      }
      await until(async () => {
        const messages = await client.session.messages({
          path: { id: sessionID },
          query: { directory },
        });
        const status = await client.session.status({ query: { directory } });
        return (
          (status.data?.[sessionID]?.type ?? "idle") === "idle" &&
          messages.data?.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "tool" &&
                part.tool === "bash" &&
                part.state.status === (mode === "allow" ? "completed" : "error"),
            ),
          )
        );
      }, `${mode} native terminal result`);
      await until(
        () => !pending.pending("owned-chat") && state.listPermissions().length === 0,
        `${mode} pending cleanup`,
      );
      assert.deepEqual(
        responses,
        mode === "externally-resolved" ? [] : [mode === "allow" ? "once" : "reject"],
      );
      const messages = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      const tools = messages.data
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "bash");
      assert.equal(tools.length, 1);
      assert.equal(tools[0].state.status, mode === "allow" ? "completed" : "error");
      allReconnects += subscriptions - 1;
    } finally {
      await escalation.close();
      pending.close();
      events.close();
      await client.session.abort({ path: { id: sessionID }, query: { directory } });
    }
  }
  assert.ok(allReconnects >= 1);
  console.log(
    "PASS: packed native permission ask/reply, current-author isolation, timeout, failed delivery, SSE reconnect, external resolution, and shutdown contract",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
