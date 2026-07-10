import type { ResolvedConfig } from "../config.js";
import { DEFAULT_OPENCODE_SERVER_URL } from "./run.js";

export interface SetupOptions {
  print?: (line: string) => void;
}

// Non-interactive setup helper: prints the exact env vars and opencode.json
// the gateway needs, reflecting whatever is already configured. Structured so
// an interactive wizard (QR pairing, self-signup) could wrap this later; for
// now it's a guidance printer that never blocks or prompts.
export function runSetup(config: ResolvedConfig, opts: SetupOptions = {}): number {
  const print = opts.print ?? ((line: string) => console.log(line));
  const have = (value: unknown) => (value ? "set" : "MISSING");
  const serverUrl = config.gateway.serverUrl ?? DEFAULT_OPENCODE_SERVER_URL;

  print("Inkbox opencode gateway — setup");
  print("");
  print("1. Environment variables");
  print("   Set these in the shell that runs the gateway:");
  print("");
  print(`     INKBOX_API_KEY      (${have(config.apiKey)})   agent-scoped Inkbox API key`);
  print(`     INKBOX_IDENTITY     (${have(config.identity)})   your agent handle`);
  print(
    `     INKBOX_SIGNING_KEY  (${have(config.signingKey)})   verifies inbound webhook signatures`,
  );
  print("");
  print("   Get credentials at https://inkbox.ai/console.");
  print("");
  print("2. opencode.json");
  print("   Register the plugin and enable the gateway:");
  print("");
  for (const line of pluginSnippet(serverUrl).split("\n")) print(`     ${line}`);
  print("");
  print("3. Provisioning (done in the Inkbox console / CLI)");
  print("   - Provision a phone number and enable iMessage for your identity.");
  print("   - Recipients must text START to your number to opt in to SMS.");
  print("");
  print("4. Start it");
  print("     opencode serve --port 4096 &");
  print("     inkbox-opencode start        # or `run` to stay in the foreground");
  print("     inkbox-opencode status");
  print("");
  print("Run `inkbox-opencode doctor` to verify everything is wired up.");
  return 0;
}

function pluginSnippet(serverUrl: string): string {
  const snippet = {
    plugin: [
      [
        "@inkbox/opencode-plugin",
        {
          gateway: {
            enabled: true,
            mode: "sidecar",
            serverUrl,
            projectDirectory: "/path/to/agent/workspace",
          },
        },
      ],
    ],
  };
  return JSON.stringify(snippet, null, 2);
}
