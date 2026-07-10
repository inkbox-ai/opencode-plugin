import type { ToolDefinition } from "@opencode-ai/plugin";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import type { VaultRuntime } from "../vault.js";

export interface ToolDeps {
  runtime: InkboxRuntime;
  config: ResolvedConfig;
  vault: VaultRuntime;
}

// One tool plus its gating metadata. Only tools that pass gating are handed
// to opencode — an unregistered tool's spec never reaches the model, so
// gating here IS the context-size control.
export interface RegisteredTool {
  // Full tool name, e.g. "inkbox_send_email".
  name: string;
  // Feature group used in tools.enable / tools.disable, e.g. "email".
  group: string;
  // Registered without any config when true.
  defaultEnabled: boolean;
  // Sensitive tools (plaintext credential reads) are only enabled by their
  // exact name — never by group or "all".
  sensitive?: boolean;
  definition: ToolDefinition;
}

export type ToolGroupBuilder = (deps: ToolDeps) => RegisteredTool[];
