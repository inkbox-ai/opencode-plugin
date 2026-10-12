import type { ResolvedConfig } from "../config.js";
import { DEFAULT_OPENCODE_SERVER_URL } from "./serve.js";
import { hostMajor, incompatibleWrappers, wrapperSource } from "./wrappers.js";

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
  print("   Optional knobs (voice, models, ports) live in .env.example —");
  print("   copy it to your workspace as .env.");
  print("");
  print("2. Load the plugin");
  print("   The installer (install.sh) wires the global ~/.config/opencode for");
  print("   you. For a per-project setup, add .opencode/plugins/inkbox.ts:");
  print("");
  const major = hostMajor(config.gateway.serve.bin) ?? 1;
  for (const line of (major === 2 ? wrapperSource(2) : wrapperSnippet(serverUrl)).split("\n"))
    print(`     ${line}`);
  for (const file of incompatibleWrappers(
    [process.cwd(), config.gateway.projectDirectory ?? process.cwd()],
    major,
  ))
    print(`   Update the V${major === 2 ? 1 : 2} wrapper at ${file}, preserving its options.`);
  print("");
  print("3. Provisioning (done in the Inkbox console / CLI)");
  print("   - Provision a phone number and enable iMessage for your identity.");
  print("   - Recipients must text START to your number to opt in to SMS.");
  print("");
  print("4. Start it");
  print("     inkbox-opencode start   # or 'run' to stay foreground");
  print("     inkbox-opencode status");
  if (major === 2)
    print(
      "   V2 uses the authenticated shared OpenCode service. Configure Inkbox in that service's environment too.",
    );
  else {
    print("   The gateway attaches to an `opencode serve` on :4096 if one is running;");
    print(`   otherwise it launches its own managed server (port ${config.gateway.serve.port}).`);
  }
  print("");
  print("5. Keep it running on boot (optional)");
  print("     inkbox-opencode autostart install");
  print("   Installs a systemd user service (Linux) or launchd agent (macOS) and");
  print("   snapshots INKBOX_* / OPENAI_API_KEY from this shell to ~/.inkbox-opencode/.env.");
  print("   To keep it alive while logged out on Linux: sudo loginctl enable-linger $USER");
  print("");
  print("Run 'inkbox-opencode doctor' to verify everything is wired up.");
  return 0;
}

function wrapperSnippet(serverUrl: string): string {
  return [
    'import InkboxPlugin from "@inkbox/opencode-plugin";',
    "",
    "export default async (input: any) => InkboxPlugin(input, {",
    '  tools: { enable: ["inkbox_place_call"] },',
    "  gateway: {",
    "    enabled: true,",
    '    mode: "sidecar",',
    `    serverUrl: ${JSON.stringify(serverUrl)},`,
    '    projectDirectory: "/path/to/agent/workspace",',
    "  },",
    "});",
  ].join("\n");
}
