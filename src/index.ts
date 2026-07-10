import type { Plugin } from "@opencode-ai/plugin";
import { createInkboxRuntime } from "./client.js";
import { resolveConfig } from "./config.js";
import { registerTools } from "./tools/index.js";
import { createVaultRuntime } from "./vault.js";

const InkboxPlugin: Plugin = async (_input, options) => {
  const config = resolveConfig(options);
  const runtime = createInkboxRuntime(
    () => ({ apiKey: config.apiKey, identity: config.identity, baseUrl: config.baseUrl }),
    console,
  );
  const vault = createVaultRuntime(runtime, { keyEnvVar: config.vaultKeyEnvVar });
  // Gating happens here: tools that aren't enabled are never registered, so
  // their specs never reach the model. inkbox_doctor reports what's off.
  const { tools } = registerTools({ runtime, config, vault });
  return {
    tool: tools,
  };
};

// The loader inspects every export and rejects non-plugin values — keep this
// module's surface to exactly one default export.
export default InkboxPlugin;
