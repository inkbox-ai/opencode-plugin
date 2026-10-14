import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createInkboxRuntime } from "./client.js";
import { resolveConfig } from "./config.js";
import { createStateStore, gatewayHome } from "./gateway/state.js";
import { registerGatewayOwner } from "./host/gateway-owner.js";
import { requestApproval } from "./host/v2-approval.js";
import { createV2Host } from "./host/v2-client.js";
import { createV2Connection, type V2Connection } from "./host/v2-connection.js";
import { projectHistory, readHistory } from "./host/v2-history.js";
import { configurationKey, InkboxHost, TurnPolicy } from "./host/v2-rpc.js";
import { registerTools } from "./tools/index.js";
import { createVaultRuntime } from "./vault.js";

export default Plugin.define({
  id: "inkbox",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);
    const instance = randomUUID();
    const installationKey = `installation/${ctx.location.directory}`;
    const savedInstallation = await ctx.storage.get(installationKey);
    const installation = typeof savedInstallation === "string" ? savedInstallation : randomUUID();
    await ctx.storage.set(installationKey, installation);
    const runtime = createInkboxRuntime(() => ({
      apiKey: config.apiKey,
      identity: config.identity,
      baseUrl: config.baseUrl,
    }));
    const vault = createVaultRuntime(runtime, { keyEnvVar: config.vaultKeyEnvVar });
    const connection = createV2Connection(config.gateway.serverUrl);
    const checked: V2Connection = {
      invalidate: () => connection.invalidate(),
      async get() {
        try {
          const client = await connection.get();
          const result = await client
            .rpc(InkboxHost)
            .hello({}, { location: { directory: ctx.location.directory } });
          if (result.instance !== instance)
            throw new Error(
              "OpenCode connection does not match this plugin instance. Configure the gateway server URL and authentication for this host.",
            );
          return client;
        } catch (error) {
          connection.invalidate();
          throw error;
        }
      },
    };
    const host = createV2Host(checked, config);
    const { tools } = registerTools({ runtime, config, vault, opencode: host });
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools))
        editor.add({
          name,
          description: definition.description,
          input: z.object(definition.args),
          options: { codemode: false },
          async execute(input, context) {
            const session = await ctx.session.get({ sessionID: context.sessionID });
            const directory = session.location.directory;
            if (!directory) throw new Error("OpenCode session directory is unavailable.");
            context.signal.throwIfAborted();
            const result = await definition.execute(input, {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory,
              worktree: directory,
              abort: context.signal,
              metadata: (update) => {
                void context.progress(update).catch(() => {});
              },
              ask: async (request) =>
                requestApproval(
                  await checked.get(),
                  {
                    ...request,
                    sessionID: context.sessionID,
                    messageID: context.messageID,
                    callID: context.id,
                    agent: context.agent,
                  },
                  context.signal,
                  config.outbound.askTimeoutMs,
                ),
            });
            if (typeof result === "string") return { content: result };
            return {
              content: [
                { type: "text" as const, text: result.output },
                ...(result.attachments ?? []).map((file) => ({
                  type: "file" as const,
                  uri: file.url,
                  mime: file.mime,
                  name: file.filename,
                })),
              ],
              metadata: { ...result.metadata, title: result.title },
            };
          },
        });
    });
    const key = (sessionID: string, messageID: string) => `turn/${sessionID}/${messageID}`;
    await ctx.rpc.register(InkboxHost, {
      hello: async () => {
        const stateProbe = createStateStore().read().hostProbe;
        return {
          version: 1 as const,
          instance,
          installation,
          ...(typeof stateProbe === "string" ? { stateProbe } : {}),
          configuration: configurationKey(config),
          tools: (await ctx.tool.list()).map((t) => t.id),
        };
      },
      prepare: async (policy) => {
        const session = await ctx.session.get({ sessionID: policy.sessionID });
        if (session.location.directory !== ctx.location.directory)
          throw new Error("OpenCode session moved to another directory.");
        const saved = await ctx.storage.get(key(policy.sessionID, policy.messageID));
        if (saved && JSON.stringify(saved) !== JSON.stringify(policy))
          throw new Error("OpenCode prompt options changed for an existing message.");
        await ctx.storage.set(key(policy.sessionID, policy.messageID), policy);
        if (session.metadata?.inkboxHost !== 1)
          await ctx.session.update({
            sessionID: policy.sessionID,
            metadata: { ...session.metadata, inkboxHost: 1 },
          });
        return { ready: true as const };
      },
    });
    await ctx.session.hook("prompt", async (event) => {
      if (event.metadata?.inkboxHost !== 1) return;
      if (!(await ctx.storage.get(key(event.sessionID, event.messageID))))
        throw new Error(
          "Inkbox prompt options are unavailable. Reconnect the gateway before retrying.",
        );
    });
    const policyFor = async (sessionID: string, messageID?: string) => {
      if ((await ctx.session.get({ sessionID })).metadata?.inkboxHost !== 1) return undefined;
      const client = await checked.get();
      const history = await readHistory(client, sessionID);
      const projection = projectHistory(history, sessionID);
      const source = messageID
        ? projection.messages.find((message) => message.info.id === messageID)?.info
        : { parentID: projection.parentID, sourceAmbiguous: projection.ambiguous };
      if (!source || source.sourceAmbiguous) {
        if (
          history.some((message) => message.type === "user" && message.metadata?.inkboxHost === 1)
        )
          throw new Error(
            "OpenCode request source is unavailable. Stop overlapping work before retrying.",
          );
        return undefined;
      }
      if (!source.parentID) return undefined;
      const user = history.find((message) => message.id === source.parentID);
      if (!user) return undefined;
      const saved = await ctx.storage.get(key(sessionID, user.id));
      if (!saved && user.metadata?.inkboxHost === 1)
        throw new Error(
          "Inkbox prompt options are unavailable. Reconnect the gateway before retrying.",
        );
      return saved ? TurnPolicy.parse(saved) : undefined;
    };
    await ctx.session.hook("context", async (event) => {
      const policy = await policyFor(event.sessionID);
      if (!policy) return;
      if (policy.system) event.system.push({ type: "text", text: policy.system });
      if (policy.tools)
        for (const name of Object.keys(event.tools))
          if (policy.tools[name] !== true) delete event.tools[name];
    });
    await ctx.tool.hook("execute.before", async (event) => {
      const policy = await policyFor(event.sessionID, event.messageID);
      if (policy?.tools && policy.tools[event.tool] !== true)
        throw new Error("This tool is unavailable for the current request.");
    });
    const directory = resolve(config.gateway.projectDirectory ?? ctx.location.directory);
    if (
      config.gateway.enabled &&
      config.gateway.mode === "plugin" &&
      resolve(ctx.location.directory) === directory
    ) {
      return registerGatewayOwner(
        resolve(gatewayHome()),
        {
          directory,
          async start() {
            const { startGateway } = await import("./gateway/index.js");
            return startGateway({
              inkbox: runtime,
              opencode: host,
              config,
              directory,
              ownsProcess: false,
            });
          },
        },
        () => console.error("[inkbox] gateway startup failed. Run inkbox-opencode doctor."),
      );
    }
  },
});
