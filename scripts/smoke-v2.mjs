import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const root = mkdtempSync(join(tmpdir(), "inkbox-v2-"));
const home = join(root, "home");
const archive = resolve(process.argv[2]);
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const binary = process.env.OPENCODE_V2_BIN ?? "opencode";
mkdirSync(home);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"),
  INKBOX_OPENCODE_HOME: join(home, "inkbox"),
  TMPDIR: tmpdir(),
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.chdir(root);
const seenRequests = [];
const model = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  seenRequests.push(body);
  const lastUser = body.messages?.findLastIndex((m) => m.role === "user") ?? -1;
  const text = JSON.stringify(body.messages?.[lastUser] ?? "");
  const tool =
    text.includes("USE_FIXTURE") &&
    !body.messages.slice(lastUser + 1).some((m) => m.role === "tool");
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${randomUUID()}`,
            type: "function",
            function: {
              name: text.includes("DOCTOR_FIXTURE") ? "inkbox_doctor" : "fixture_echo",
              arguments: JSON.stringify(
                text.includes("DOCTOR_FIXTURE")
                  ? {}
                  : {
                      value: text.includes("TIMEOUT_FIXTURE") ? "timeout" : "Synthetic result",
                    },
              ),
            },
          },
        ],
      }
    : { role: "assistant", content: "Synthetic completed" };
  const finish = tool ? "tool_calls" : "stop";
  const base = {
    id: "synthetic",
    created: 1,
    model: body.model,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: delta, finish_reason: finish }],
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (value, reason) =>
    res.write(
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
    );
  send(delta, null);
  if (text.includes("HOLD_FIXTURE")) {
    const timer = setTimeout(() => {
      send({}, "stop");
      res.end("data: [DONE]\n\n");
    }, 60000);
    res.on("close", () => clearTimeout(timer));
  } else {
    send({}, finish);
    res.end("data: [DONE]\n\n");
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
let child;
let abort;
let reader;
const until = async (predicate, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: root,
    env,
    stdio: "pipe",
  });
  const packed = join(root, "node_modules/@inkbox/opencode-plugin/dist");
  const load = (file) => import(pathToFileURL(join(packed, file)).href);
  const { resolveConfig } = await load("config.js");
  const { createV2Host } = await load("host/v2-client.js");
  const { createV2Connection } = await load("host/v2-connection.js");
  const { readHistory } = await load("host/v2-history.js");
  const { InkboxHost } = await load("host/v2-rpc.js");
  const { createSessionManager } = await load("gateway/sessions.js");
  const { createStateStore } = await load("gateway/state.js");
  const pluginDir = join(root, ".opencode/plugins");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "inkbox.ts"),
    `
import Inkbox from '@inkbox/opencode-plugin/v2';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { z } from 'zod';
import { requestApproval } from ${JSON.stringify(join(packed, "host/v2-approval.js"))};
import { createV2Host } from ${JSON.stringify(join(packed, "host/v2-client.js"))};
import { resolveConfig } from ${JSON.stringify(join(packed, "config.js"))};
export default { ...Inkbox, async setup(ctx) {
  const close = await Inkbox.setup(ctx);
  await ctx.tool.transform(editor => editor.add({ name:'fixture_echo',description:'Synthetic echo',input:z.object({value:z.string().min(1)}),options:{codemode:false},async execute(input, context) {
    const endpoint = await Service.discover();
    const client = OpenCode.make({baseUrl:endpoint.url,headers:Service.headers(endpoint)});
    const host = createV2Host({get:async()=>client,invalidate(){}},resolveConfig(ctx.options));
    const source = (await host.session.message({path:{id:context.sessionID,messageID:context.messageID}})).data;
    if (!source.info.parentID || !source.parts.some(part=>part.type==='tool'&&part.callID===context.id&&part.state.input?.value===input.value)) throw new Error('Synthetic source mismatch');
    await requestApproval(client,{sessionID:context.sessionID,messageID:context.messageID,callID:context.id,agent:context.agent,permission:'fixture_send',patterns:['fixture@example.test'],always:['fixture@example.test'],metadata:{}},context.signal,input.value==='timeout'?500:10000);
    return {content:input.value};
  }}));
  return close;
}};
`,
  );
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({
      model: "fixture/fixture",
      agents: { alternate: { mode: "primary", description: "Synthetic alternative" } },
      providers: {
        fixture: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "synthetic" },
          models: {
            fixture: {
              name: "fixture",
              limit: { context: 32000, output: 2000 },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
            },
          },
        },
      },
    }),
  );
  const registration = join(env.XDG_STATE_HOME, "opencode/service.json");
  const start = () => {
    child = spawn(binary, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: root,
      env,
      stdio: [
        "ignore",
        openSync(join(root, "serve.log"), "a"),
        openSync(join(root, "serve-error.log"), "a"),
      ],
    });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exit = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exit;
  };
  start();
  let endpoint;
  await until(async () => {
    endpoint = await Service.discover({ file: registration });
    return Boolean(endpoint);
  }, "service startup");
  let client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const connection = createV2Connection(undefined, undefined, [
    binary,
    "serve",
    "--service",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
  ]);
  const host = createV2Host(connection, resolveConfig({}, {}));
  const permissionEvents = [];
  abort = new AbortController();
  const eventStream = await host.event.subscribe({
    query: { directory: root },
    signal: abort.signal,
  });
  reader = (async () => {
    for await (const event of eventStream.stream) permissionEvents.push(event);
  })().catch(() => {});
  const create = async (title) => {
    const s = await client.session.create({
      title,
      location: { directory: root },
      permissions: [{ action: "fixture_send", resource: "*", effect: "ask" }],
    });
    await client.session.switchModel({
      sessionID: s.id,
      model: { providerID: "fixture", id: "fixture" },
    });
    return s.id;
  };
  const sessionID = await create("Synthetic lifecycle");
  await host.ready(root);
  const sessions = createSessionManager({
    opencode: host,
    config: resolveConfig({ gateway: { model: "fixture/fixture" } }, {}),
    state: createStateStore(join(home, "gateway-fixture")),
    directory: root,
    inkbox: {
      getIdentity: async () => ({ agentHandle: "synthetic", emailAddress: "fixture@example.test" }),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    assert.equal(
      await sessions.runText("first", "Synthetic gateway question"),
      "Synthetic completed",
    );
    assert.deepEqual(
      await Promise.all([
        sessions.runText("first", "Synthetic follow-up"),
        sessions.runText("second", "Synthetic concurrent question"),
      ]),
      ["Synthetic completed", "Synthetic completed"],
    );
  } finally {
    await sessions.close();
  }
  const info = await client.rpc(InkboxHost).hello({}, { location: { directory: root } });
  assert.ok(info.tools.includes("inkbox_send_email"));
  assert.ok(!info.tools.includes("inkbox_credentials_get_secret"));
  assert.ok(
    (await client.plugin.list({ location: { directory: root } })).data.some(
      (p) => p.id === "inkbox",
    ),
  );
  const prompt = async (id, text, extra = {}, session = sessionID) =>
    host.session.promptAsync({
      path: { id: session },
      query: { directory: root },
      body: { messageID: id, parts: [{ type: "text", text }], ...extra },
    });
  const wait = (session) =>
    client.session.wait({ sessionID: session }, { signal: AbortSignal.timeout(30000) });
  const messageID = `msg_${randomUUID()}`;
  await prompt(messageID, "Synthetic question", { system: "FIXTURE_CONTEXT", tools: {} });
  await wait(sessionID);
  assert.ok(JSON.stringify(seenRequests).includes("FIXTURE_CONTEXT"));
  assert.equal(seenRequests.at(-1).tools?.length ?? 0, 0);
  const normalized = (await host.session.messages({ path: { id: sessionID } })).data;
  assert.equal(normalized.findLast((m) => m.info.role === "assistant").info.parentID, messageID);
  const count = seenRequests.length;
  await prompt(messageID, "Synthetic question", { system: "FIXTURE_CONTEXT", tools: {} });
  await wait(sessionID);
  assert.equal(seenRequests.length, count);
  await prompt(`msg_${randomUUID()}`, "Synthetic alternate", { agent: "alternate", tools: {} });
  await wait(sessionID);
  assert.equal((await client.session.get({ sessionID })).agent, "alternate");
  await prompt(`msg_${randomUUID()}`, "Synthetic default", { tools: {} });
  await wait(sessionID);
  assert.equal((await client.session.get({ sessionID })).agent, "build");
  await client.session.synthetic({
    sessionID,
    text: "Synthetic background completion",
    resume: true,
  });
  await wait(sessionID);
  assert.equal(
    (await host.session.messages({ path: { id: sessionID } })).data.findLast(
      (m) => m.info.role === "assistant",
    ).info.parentID,
    undefined,
  );
  const defaults = await client.session.create({
    title: "Synthetic native defaults",
    location: { directory: root },
  });
  await client.session.switchModel({
    sessionID: defaults.id,
    model: { providerID: "fixture", id: "fixture" },
  });
  await prompt(
    `msg_${randomUUID()}`,
    "USE_FIXTURE",
    { tools: { fixture_echo: true } },
    defaults.id,
  );
  await wait(defaults.id);
  const defaultTool = (await readHistory(client, defaults.id))
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.content)
    .find((p) => p.type === "tool");
  assert.equal(defaultTool.state.status, "completed");
  assert.equal((await client.permission.list({ sessionID: defaults.id })).length, 0);
  for (const decision of ["once", "reject", "timeout", "cancel", "always"]) {
    const sid = await create(`Synthetic approval ${decision}`);
    await prompt(
      `msg_${randomUUID()}`,
      decision === "timeout" ? "USE_FIXTURE TIMEOUT_FIXTURE" : "USE_FIXTURE",
      { tools: { fixture_echo: true } },
      sid,
    );
    let request;
    await until(async () => {
      request = (await client.permission.list({ sessionID: sid })).find(
        (p) => p.action === "fixture_send",
      );
      return Boolean(request);
    }, "approval request");
    assert.ok(request.source?.messageID);
    const inventory = await host.permissionInventory(root, AbortSignal.timeout(5000));
    assert.ok(
      inventory.some((p) => p.id === request.id && p.tool?.messageID === request.source.messageID),
    );
    if (decision === "cancel") await host.session.abort({ path: { id: sid } });
    else if (decision !== "timeout")
      assert.equal(
        (
          await host.postSessionIdPermissionsPermissionId({
            path: { id: sid, permissionID: request.id },
            body: { response: decision },
          })
        ).data,
        true,
      );
    await wait(sid);
    const messages = await readHistory(client, sid);
    const tool = messages
      .filter((m) => m.type === "assistant")
      .flatMap((m) => m.content)
      .find((p) => p.type === "tool");
    assert.equal(tool.state.status, ["once", "always"].includes(decision) ? "completed" : "error");
    if (["timeout", "cancel"].includes(decision)) {
      await until(
        async () =>
          !(await client.permission.list({ sessionID: sid })).some((p) => p.id === request.id),
        "approval cleanup",
      );
      await assert.rejects(() =>
        client.permission.reply({ sessionID: sid, requestID: request.id, decision: "once" }),
      );
    }
  }
  assert.ok(
    permissionEvents.some((e) => e.type === "permission.asked" && e.properties?.tool?.messageID),
  );
  const sid = await create("Synthetic remembered approval");
  await prompt(`msg_${randomUUID()}`, "USE_FIXTURE", { tools: { fixture_echo: true } }, sid);
  await wait(sid);
  assert.equal((await client.permission.list({ sessionID: sid })).length, 0);
  const held = await create("Synthetic cancellation");
  await prompt(`msg_${randomUUID()}`, "HOLD_FIXTURE", {}, held);
  await until(
    async () =>
      seenRequests.some((request) => JSON.stringify(request.messages).includes("HOLD_FIXTURE")) &&
      Boolean((await client.session.active())[held]),
    "active generation",
  );
  await client.session.prompt({
    sessionID: held,
    id: `msg_${randomUUID()}`,
    text: "Queued fixture",
    delivery: "queue",
    resume: false,
  });
  assert.equal((await host.session.abort({ path: { id: held } })).data, true);
  assert.equal((await client.session.inbox.list({ sessionID: held })).length, 0);
  assert.equal((await client.session.active())[held], undefined);
  await client.session.compact({ sessionID, delivery: "queue" });
  await wait(sessionID);
  assert.ok((await readHistory(client, sessionID)).some((m) => m.id === messageID));
  await stop();
  await host.ready(root);
  await until(async () => {
    endpoint = await Service.discover({ file: registration });
    return Boolean(endpoint);
  }, "service restart");
  client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await host.ready(root);
  await prompt(`msg_${randomUUID()}`, "Synthetic after restart", { tools: {} });
  await wait(sessionID);
  const beforeReload = await client.rpc(InkboxHost).hello({}, { location: { directory: root } });
  const wrapper = join(pluginDir, "inkbox.ts");
  writeFileSync(
    wrapper,
    readFileSync(wrapper, "utf8").replace(
      "Inkbox.setup(ctx)",
      "Inkbox.setup({...ctx, options: {...ctx.options, gateway: {serverUrl: 'http://127.0.0.1:1'}}})",
    ),
  );
  await client.location.reload();
  await until(async () => {
    const current = await client
      .rpc(InkboxHost)
      .hello({}, { location: { directory: root } })
      .catch(() => undefined);
    return current && current.instance !== beforeReload.instance;
  }, "plugin reload");
  const interactive = await create("Synthetic interactive request");
  await client.session.prompt({ sessionID: interactive, text: "USE_FIXTURE DOCTOR_FIXTURE" });
  await wait(interactive);
  const interactiveMessages = await readHistory(client, interactive);
  assert.ok(
    interactiveMessages
      .filter((m) => m.type === "assistant")
      .flatMap((m) => m.content)
      .some(
        (part) =>
          part.type === "tool" &&
          part.name === "inkbox_doctor" &&
          part.state.status === "completed",
      ),
  );
  await stop();
  console.log(
    "PASS: packed OpenCode V2 plugin, approvals, prompt lifecycle, compaction, cancellation, and restart",
  );
} finally {
  abort?.abort();
  await reader;
  await Service.stop({ file: join(env.XDG_STATE_HOME, "opencode/service.json") });
  if (child?.exitCode === null) {
    const exit = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exit;
  }
  model.closeAllConnections();
  model.close();
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  if (process.env.KEEP_SMOKE_FILES) console.log(`Fixture directory: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
