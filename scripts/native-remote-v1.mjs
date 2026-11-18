import { createOpencodeClient } from "@opencode-ai/sdk";
import { assertRemoteNative } from "./remote-native-fixture.mjs";

const [directory, port, modelPort] = process.argv.slice(2);
const host = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const controller = new AbortController();
const decisions = new Map();
const events = await host.event.subscribe({ query: { directory }, signal: controller.signal });
const reader = (async () => {
  for await (const event of events.stream) {
    if (!["permission.asked", "permission.updated"].includes(event.type)) continue;
    const request = event.properties;
    if (!decisions.has(request.sessionID)) continue;
    const result = await host.postSessionIdPermissionsPermissionId({
      path: { id: request.sessionID, permissionID: request.id },
      query: { directory },
      body: { response: decisions.get(request.sessionID) },
    });
    if (result.error) throw new Error("Synthetic native approval reply failed");
  }
})();
try {
  await assertRemoteNative(
    host,
    directory,
    async (effect = "allow") => {
      const result = await host.session.create({
        query: { directory },
        body: { title: "Synthetic remote" },
      });
      if (!result.data?.id) throw new Error("Synthetic native session unavailable");
      decisions.set(result.data.id, effect === "deny" ? "reject" : "once");
      return result.data.id;
    },
    `http://127.0.0.1:${modelPort}`,
    { providerID: "mock", modelID: "mock-model" },
  );
} finally {
  controller.abort();
  await reader.catch(() => {});
}
