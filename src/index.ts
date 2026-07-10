import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { createInkboxRuntime } from "./client.js";
import { resolveConfig } from "./config.js";
import type { GatewayHandle } from "./gateway/types.js";
import { registerTools } from "./tools/index.js";
import { createVaultRuntime } from "./vault.js";

const InkboxPlugin: Plugin = async (input, options) => {
  const config = resolveConfig(options);
  const runtime = createInkboxRuntime(
    () => ({ apiKey: config.apiKey, identity: config.identity, baseUrl: config.baseUrl }),
    console,
  );
  const vault = createVaultRuntime(runtime, { keyEnvVar: config.vaultKeyEnvVar });
  // Gating happens here: tools that aren't enabled are never registered, so
  // their specs never reach the model. inkbox_doctor reports what's off.
  const { tools } = registerTools({ runtime, config, vault });

  // In-plugin gateway mode: start the inbound gateway inside opencode. Deferred
  // past plugin init (awaiting server-API calls here would deadlock instance
  // creation) and guarded so a second plugin load doesn't open a second tunnel.
  let disposed = false;
  let startPromise: Promise<GatewayHandle | undefined> | undefined;
  if (config.gateway.enabled && config.gateway.mode === "plugin" && !inPluginStarted) {
    inPluginStarted = true;
    startPromise = startInPluginGateway(input, config, runtime).catch((err) => {
      // A failed start must not permanently latch the gateway off.
      inPluginStarted = false;
      console.error("[inkbox] gateway failed to start:", err);
      return undefined;
    });
  }

  return {
    tool: tools,
    dispose: async () => {
      disposed = true;
      // Await any in-flight start so dispose can't race past it and leak the
      // tunnel / webhook listener.
      const handle = await startPromise;
      await handle?.close();
      inPluginStarted = false;
    },
  };

  async function startInPluginGateway(
    pluginInput: PluginInput,
    resolved: ReturnType<typeof resolveConfig>,
    inkbox: ReturnType<typeof createInkboxRuntime>,
  ): Promise<GatewayHandle | undefined> {
    // Defer to a later tick so instance creation is not blocked on our
    // server-API calls.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (disposed) return undefined;
    const { startGateway } = await import("./gateway/index.js");
    const handle = await startGateway({
      inkbox,
      opencode: pluginInput.client,
      config: resolved,
      directory: resolved.gateway.projectDirectory ?? pluginInput.directory,
      ownsProcess: false,
    });
    // If dispose landed while we were starting, tear down immediately.
    if (disposed) {
      await handle.close();
      return undefined;
    }
    return handle;
  }
};

let inPluginStarted = false;

// The loader inspects every export and rejects non-plugin values — keep this
// module's surface to exactly one default export.
export default InkboxPlugin;
