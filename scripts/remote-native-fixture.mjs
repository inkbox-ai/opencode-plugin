import assert from "node:assert/strict";

export function remoteFixture() {
  let tools = [
    {
      name: "inkbox_synthetic",
      description: "First",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 2 } },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
    },
  ];
  const calls = [];
  return (body) => {
    let result;
    if (body.method === "fixture.catalog") {
      tools = body.tools;
      result = { ok: true };
    } else if (body.method === "fixture.calls") result = { calls };
    else if (body.method === "server/discover") result = { supportedVersions: ["2026-07-28"] };
    else if (body.method === "tools/list") result = { tools };
    else if (body.method === "tools/call") {
      calls.push(body.params);
      result = body.params.requestState
        ? {
            content: [{ type: "text", text: "Synthetic remote accepted" }],
            structuredContent: { id: "receipt", nested: { preserved: true } },
            _meta: { receipt: "synthetic" },
          }
        : { resultType: "input_required", requestState: `state-${calls.length}` };
    } else return;
    return { jsonrpc: "2.0", id: body.id, result };
  };
}

export function remoteTool(text) {
  if (!text.includes("REMOTE_")) return;
  return {
    name: text.includes("REMOTE_LIST") ? "inkbox_remote_tools" : "inkbox_remote_call",
    arguments: JSON.stringify(
      text.includes("REMOTE_LIST")
        ? {}
        : {
            name: "inkbox_synthetic",
            arguments: { text: text.includes("REMOTE_INVALID") ? "x" : "Synthetic" },
          },
    ),
  };
}

export function runtimeSource(url) {
  return `{getClient:async()=>({_apiKey:'synthetic',_baseUrl:${JSON.stringify(url)},whoami:async()=>({authSubtype:'api_key.agent_scoped.claimed'})}),getIdentity:async()=>({id:'synthetic'})}`;
}

export async function assertRemoteNative(host, directory, create, url, model) {
  const sessionID = await create();
  const query = { directory };
  const control = async (body) =>
    (
      await (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()
    ).result;
  const run = async (text, target = sessionID) => {
    const submitted = await host.session.prompt({
      path: { id: target },
      query,
      body: { model, parts: [{ type: "text", text }] },
    });
    if (submitted.error) throw new Error(JSON.stringify(submitted.error));
    const messages = (await host.session.messages({ path: { id: target }, query })).data;
    const part = messages
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === "tool" && p.tool?.startsWith("inkbox_remote_"))
      .at(-1);
    assert.ok(part, `Native remote tool absent: ${text}`);
    return part;
  };
  const first = await run("REMOTE_LIST");
  assert.equal(first.state.metadata.inkboxRemote.tools[0].inputSchema.properties.text.minLength, 2);
  const accepted = await run("REMOTE_CALL");
  assert.ok(accepted.state.metadata?.inkboxRemote, JSON.stringify(accepted));
  assert.deepEqual(accepted.state.metadata.inkboxRemote.structuredContent, {
    id: "receipt",
    nested: { preserved: true },
  });
  assert.deepEqual(accepted.state.metadata.inkboxRemote._meta, { receipt: "synthetic" });
  await run("REMOTE_CALL again");
  const calls = (await control({ method: "fixture.calls" })).calls;
  assert.equal(calls.length, 4);
  assert.equal(calls[0].requestState, undefined);
  assert.equal(calls[2].requestState, undefined);
  assert.notEqual(calls[1].requestState, calls[3].requestState);
  await run("REMOTE_INVALID");
  assert.equal((await control({ method: "fixture.calls" })).calls.length, 4);
  await control({
    method: "fixture.catalog",
    tools: [
      { name: "inkbox_synthetic", description: "Changed", inputSchema: { type: "object" } },
      { name: "inkbox_added", inputSchema: { type: "object" } },
    ],
  });
  const changed = await run("REMOTE_LIST changed");
  assert.equal(changed.state.metadata.inkboxRemote.tools.length, 2);
  assert.equal(changed.state.metadata.inkboxRemote.tools[0].description, "Changed");
  const denied = await run("REMOTE_CALL denied", await create("deny"));
  assert.equal(denied.state.status, "error");
  assert.equal((await control({ method: "fixture.calls" })).calls.length, 4);
  await control({ method: "fixture.catalog", tools: [] });
  const removed = await run("REMOTE_LIST removed");
  assert.equal(removed.state.metadata.inkboxRemote.tools.length, 0);
  console.log(
    "PASS: native remote catalog changes, full schemas/results, distinct call identity and invalid-argument rejection",
  );
}
