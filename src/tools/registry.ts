import type { ToolDefinition } from "@opencode-ai/plugin";
import type { RegisteredTool } from "./types.js";

export interface GatingSummary {
  enabled: string[];
  disabledByDefault: { name: string; group: string; sensitive: boolean }[];
  groups: string[];
}

// Selection precedence, most-specific first: exact name beats group beats
// "all"; at equal specificity, disable beats enable. Sensitive tools are the
// exception — only an exact-name enable turns them on.
export function isToolEnabled(
  tool: RegisteredTool,
  enable: Set<string>,
  disable: Set<string>,
): boolean {
  if (disable.has(tool.name)) return false;
  if (enable.has(tool.name)) return true;
  if (tool.sensitive) return false;
  if (disable.has(tool.group)) return false;
  if (enable.has(tool.group)) return true;
  if (disable.has("all")) return false;
  if (enable.has("all")) return true;
  return tool.defaultEnabled;
}

export function selectTools(
  all: RegisteredTool[],
  cfg: { enable: string[]; disable: string[] },
): { tools: Record<string, ToolDefinition>; summary: GatingSummary } {
  const enable = new Set(cfg.enable);
  const disable = new Set(cfg.disable);
  const tools: Record<string, ToolDefinition> = {};
  const summary: GatingSummary = {
    enabled: [],
    disabledByDefault: [],
    groups: [...new Set(all.map((t) => t.group))],
  };
  for (const tool of all) {
    if (isToolEnabled(tool, enable, disable)) {
      tools[tool.name] = tool.definition;
      summary.enabled.push(tool.name);
    } else {
      summary.disabledByDefault.push({
        name: tool.name,
        group: tool.group,
        sensitive: tool.sensitive ?? false,
      });
    }
  }
  return { tools, summary };
}

// Rendered into doctor/whoami output so the model can tell the user what
// exists but is switched off, instead of being silently capability-blind.
export function describeGating(summary: GatingSummary): string {
  const byGroup = new Map<string, { names: string[]; sensitive: string[] }>();
  for (const t of summary.disabledByDefault) {
    const entry = byGroup.get(t.group) ?? { names: [], sensitive: [] };
    (t.sensitive ? entry.sensitive : entry.names).push(t.name);
    byGroup.set(t.group, entry);
  }
  if (byGroup.size === 0) return "All tools are enabled.";
  const lines: string[] = [
    "Disabled tools (enable via the plugin option tools.enable in opencode.json, then restart opencode):",
  ];
  for (const [group, entry] of byGroup) {
    if (entry.names.length > 0) {
      lines.push(`- ${group}: ${entry.names.join(", ")} (enable by name or with "${group}")`);
    }
    if (entry.sensitive.length > 0) {
      lines.push(`- ${group} (sensitive, exact name required): ${entry.sensitive.join(", ")}`);
    }
  }
  return lines.join("\n");
}
