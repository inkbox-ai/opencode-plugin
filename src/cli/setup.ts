import type { ResolvedConfig } from "../config.js";
import { DEFAULT_OPENCODE_SERVER_URL } from "./run.js";

export interface SetupOptions {
  print?: (line: string) => void;
}

// Non-interactive setup helper: prints the env vars and the local plugin
// wrapper the gateway needs, reflecting whatever is already configured. This
// plugin is distributed as source, so setup points at a cloned + built copy
// rather than an npm package.
export function runSetup(config: ResolvedConfig, opts: SetupOptions = {}): number {
  const print = opts.print ?? ((line: string) => console.log(line));
  const have = (value: unknown) => (value ? "set" : "MISSING");
  const serverUrl = config.gateway.serverUrl ?? DEFAULT_OPENCODE_SERVER_URL;
  const clone = "/path/to/opencode-plugin";

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
  print("2. Load the plugin");
  print("   Clone + build the repo, then in your opencode project add");
  print("   .opencode/plugins/inkbox.ts (installed from the local clone):");
  print("");
  for (const line of wrapperSnippet(serverUrl).split("\n")) print(`     ${line}`);
  print("");
  print("3. Provisioning (done in the Inkbox console / CLI)");
  print("   - Provision a phone number and enable iMessage for your identity.");
  print("   - Recipients must text START to your number to opt in to SMS.");
  print("");
  print("4. Start it");
  print("     opencode serve --port 4096 &");
  print(`     node ${clone}/bin/inkbox-opencode.js start   # or 'run' to stay foreground`);
  print(`     node ${clone}/bin/inkbox-opencode.js status`);
  print("");
  print(`Run 'node ${clone}/bin/inkbox-opencode.js doctor' to verify everything is wired up.`);
  return 0;
}

function wrapperSnippet(serverUrl: string): string {
  return [
    'import InkboxPlugin from "@inkbox/opencode-plugin";',
    "",
    "export default async (input: any) => InkboxPlugin(input, {",
    "  gateway: {",
    "    enabled: true,",
    '    mode: "sidecar",',
    `    serverUrl: ${JSON.stringify(serverUrl)},`,
    '    projectDirectory: "/path/to/agent/workspace",',
    "  },",
    "});",
  ].join("\n");
}
