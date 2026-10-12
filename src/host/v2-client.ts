import { randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../config.js";
import { createStateStore } from "../gateway/state.js";
import { bindHostState } from "./state.js";
import type { HostClient } from "./types.js";
import type { V2Connection } from "./v2-connection.js";
import { normalizeHistory, readHistory } from "./v2-history.js";
import { configurationKey, InkboxHost } from "./v2-rpc.js";

export function createV2Host(connection: V2Connection, config: ResolvedConfig): HostClient {
  const sessions = new Map<string, Promise<unknown>>();
  const serial = <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
    const result = (sessions.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation);
    sessions.set(sessionID, result);
    void result
      .finally(() => {
        if (sessions.get(sessionID) === result) sessions.delete(sessionID);
      })
      .catch(() => {});
    return result;
  };
  const call = async <T>(
    operation: (client: Awaited<ReturnType<V2Connection["get"]>>) => Promise<T>,
    retryRead = false,
  ): Promise<T> => {
    try {
      return await operation(await connection.get());
    } catch (error) {
      connection.invalidate();
      if (retryRead && isConnectionFailure(error)) return call(operation);
      if ((error as { reason?: string })?.reason === "Transport")
        throw Object.assign(new Error("OpenCode connection interrupted.", { cause: error }), {
          code: "ECONNRESET",
        });
      throw error;
    }
  };
  const hello = (directory: string) =>
    call(async (client) => {
      const result = await client.rpc(InkboxHost).hello({}, { location: { directory } });
      if (result.configuration !== configurationKey(config))
        throw new Error(
          "Inkbox configuration differs between the gateway and OpenCode. Check identity, channel options, and state directory.",
        );
      return result;
    }, true);
  const history = (sessionID: string, signal?: AbortSignal) =>
    call(
      async (client) => normalizeHistory(await readHistory(client, sessionID, signal), sessionID),
      true,
    );
  const submit = async (args: any) =>
    serial(args.path.id, () =>
      call(async (client) => {
        const directory = args.query?.directory;
        const sessionID = args.path.id;
        const body = args.body;
        await hello(directory);
        const id = body.messageID ?? `msg_${randomUUID()}`;
        await client
          .rpc(InkboxHost)
          .prepare(
            { sessionID, messageID: id, system: body.system, tools: body.tools },
            { location: { directory } },
          );
        const agent =
          body.agent ??
          (await client.agent.list({ location: { directory } })).data.find(
            (agent) => agent.mode !== "subagent" && !agent.hidden,
          )?.id;
        if (!agent) throw new Error("OpenCode has no default agent for this directory.");
        await client.session.switchAgent({ sessionID, agent });
        if (body.model)
          await client.session.switchModel({
            sessionID,
            model: { providerID: body.model.providerID, id: body.model.modelID },
          });
        await client.session.prompt(
          {
            sessionID,
            id,
            text: body.parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n"),
            delivery: "queue",
            metadata: { inkboxHost: 1 },
          },
          { signal: args.signal },
        );
        return id;
      }),
    );
  const host = {
    protocol: 2 as const,
    ready: async (directory: string) => {
      const state = createStateStore();
      const probe = randomUUID();
      state.update({ hostProbe: probe });
      const info = await hello(directory);
      if (info.stateProbe !== probe)
        throw new Error(
          "The gateway and OpenCode plugin must use the same accessible Inkbox state directory.",
        );
      bindHostState(state, 2, `${info.installation}:${directory}`);
    },
    config: { get: async () => ({ data: await call((c) => c.server.info(), true) }) },
    tool: { ids: async (a: any) => ({ data: (await hello(a.query.directory)).tools }) },
    session: {
      create: async (a: any) => {
        await hello(a.query.directory);
        const session = await call((c) =>
          c.session.create({ title: a.body?.title, location: { directory: a.query.directory } }),
        );
        return { data: { ...session, directory: session.location.directory } };
      },
      get: async (a: any) => {
        try {
          const s = await call(
            (c) => c.session.get({ sessionID: a.path.id }, { signal: a.signal }),
            true,
          );
          return { data: { ...s, directory: s.location.directory } };
        } catch (error) {
          if ((error as any)?._tag === "SessionNotFoundError")
            return { error, response: { status: 404 } };
          throw error;
        }
      },
      list: async (a: any) => ({
        data: (await call((c) => c.session.list({ directory: a.query.directory }), true)).data,
      }),
      messages: async (a: any) => {
        const messages = await history(a.path.id, a.signal);
        const pending = await call(
          (c) => c.session.inbox.list({ sessionID: a.path.id }, { signal: a.signal }),
          true,
        );
        for (const p of pending)
          if (p.type === "user" && !messages.some((m) => m.info.id === p.id))
            messages.push({
              info: { id: p.id, sessionID: p.sessionID, role: "user" },
              parts: [{ type: "text", text: p.payload.text }],
            });
        return { data: messages };
      },
      message: async (a: any) => {
        const message = (await history(a.path.id, a.signal)).find(
          (m) => m.info.id === a.path.messageID,
        );
        if (!message) throw new Error("OpenCode message is unavailable.");
        return { data: message };
      },
      promptAsync: async (a: any) => {
        await submit(a);
        return { data: undefined };
      },
      prompt: async (a: any) => {
        const id = await submit(a);
        await call((c) => c.session.wait({ sessionID: a.path.id }, { signal: a.signal }));
        const message = (await history(a.path.id))
          .filter((m) => m.info.role === "assistant" && m.info.parentID === id)
          .at(-1);
        if (!message) throw new Error("OpenCode did not complete this prompt.");
        return { data: message };
      },
      abort: async (a: any) =>
        serial(a.path.id, () =>
          call(async (c) => {
            const sessionID = a.path.id;
            for (const item of await c.session.inbox.list({ sessionID }))
              await c.session.inbox.cancel({ sessionID, inboxID: item.id });
            await c.session.interrupt({ sessionID, resume: false });
            await c.session.wait({ sessionID }, { signal: AbortSignal.timeout(10000) });
            const pending = await c.session.inbox.list({ sessionID });
            const active = await c.session.active();
            if (pending.length || active[sessionID])
              throw new Error("OpenCode has not confirmed this session stopped.");
            return { data: true };
          }),
        ),
      status: async () => ({ data: await call((c) => c.session.active(), true) }),
      delete: async (a: any) => {
        await call((c) => c.session.remove({ sessionID: a.path.id }));
        return { data: true };
      },
    },
    permissionInventory: async (directory: string, signal: AbortSignal) => {
      const result = await call(
        (c) => c.permission.request.list({ location: { directory } }, { signal }),
        true,
      );
      return result.data.map(normalizePermission);
    },
    postSessionIdPermissionsPermissionId: async (a: any) => {
      await call((c) =>
        c.permission.reply(
          { sessionID: a.path.id, requestID: a.path.permissionID, decision: a.body.response },
          { signal: a.signal },
        ),
      );
      return { data: true };
    },
    event: {
      subscribe: async (a: any) => {
        const client = await connection.get();
        return {
          stream: (async function* () {
            try {
              for await (const event of client.event.subscribe({ signal: a.signal })) {
                const e = event as any;
                if (e.location?.directory && e.location.directory !== a.query?.directory) continue;
                yield {
                  type: e.type,
                  properties: e.type === "permission.asked" ? normalizePermission(e.data) : e.data,
                };
              }
            } finally {
              connection.invalidate();
            }
          })(),
        };
      },
    },
  };
  return host as unknown as HostClient;
}

function normalizePermission(p: any) {
  return {
    ...p,
    permission: p.action,
    patterns: p.resources,
    tool: p.source ? { messageID: p.source.messageID, callID: p.source.id } : undefined,
  };
}

function isConnectionFailure(error: unknown): boolean {
  const value = error as {
    _tag?: string;
    reason?: string;
    code?: string;
    cause?: { code?: string; name?: string };
  };
  return (
    value?._tag === "UnauthorizedError" ||
    (value?.reason === "Transport" && value.cause?.name !== "AbortError") ||
    ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
      value?.code ?? value?.cause?.code ?? "",
    )
  );
}
