import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type OutboundApproval = "ask" | "allowlist" | "auto";

// Options accepted via the opencode.json plugin tuple:
//   "plugin": [["@inkbox/opencode-plugin", { ...options }]]
// Every credential also resolves from env vars, so options are never required.
export interface InkboxPluginOptions {
  apiKey?: string;
  identity?: string;
  baseUrl?: string;
  signingKey?: string;
  // WebSocket URL (wss://) Inkbox connects to for outbound-call audio.
  // Only needed for inkbox_place_call when no per-call URL is passed.
  callWebsocketUrl?: string;
  vault?: {
    keyEnvVar?: string;
  };
  tools?: {
    enable?: string[];
    disable?: string[];
  };
  outbound?: {
    allowedRecipients?: string[];
    approval?: OutboundApproval;
    askTimeoutMs?: number;
  };
}

export interface ResolvedConfig {
  apiKey?: string;
  identity?: string;
  baseUrl?: string;
  signingKey?: string;
  callWebsocketUrl?: string;
  vaultKeyEnvVar: string;
  tools: {
    enable: string[];
    disable: string[];
  };
  outbound: {
    allowedRecipients: string[];
    approval: OutboundApproval;
    askTimeoutMs: number;
  };
}

export const DEFAULT_VAULT_KEY_ENV_VAR = "INKBOX_VAULT_KEY";
// Approval prompts fail after this long so a headless run degrades to a clear
// error instead of hanging on a prompt nobody will answer.
export const DEFAULT_ASK_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

// ~/.inkbox/config — `key = value` lines, the same file the Inkbox SDK and CLI
// read. Lowest-precedence credential source, after options and env vars.
function readInkboxConfigFile(): Record<string, string> {
  try {
    const file = path.join(os.homedir(), ".inkbox", "config");
    const text = fs.readFileSync(file, "utf-8");
    const out: Record<string, string> = {};
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveConfig(
  options: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const opts: InkboxPluginOptions = isRecord(options) ? (options as InkboxPluginOptions) : {};
  let file: Record<string, string> | undefined;
  const fromFile = (key: string): string | undefined => {
    file ??= readInkboxConfigFile();
    return nonEmptyString(file[key]);
  };

  const apiKey =
    nonEmptyString(opts.apiKey) ?? nonEmptyString(env.INKBOX_API_KEY) ?? fromFile("api_key");
  const identity =
    nonEmptyString(opts.identity) ??
    nonEmptyString(env.INKBOX_IDENTITY) ??
    nonEmptyString(env.INKBOX_AGENT_IDENTITY) ??
    nonEmptyString(env.INKBOX_AGENT_HANDLE) ??
    fromFile("identity");
  const baseUrl =
    nonEmptyString(opts.baseUrl) ?? nonEmptyString(env.INKBOX_BASE_URL) ?? fromFile("base_url");
  const signingKey =
    nonEmptyString(opts.signingKey) ??
    nonEmptyString(env.INKBOX_SIGNING_KEY) ??
    fromFile("signing_key");
  const callWebsocketUrl =
    nonEmptyString(opts.callWebsocketUrl) ?? nonEmptyString(env.INKBOX_CALL_WEBSOCKET_URL);

  const outbound = isRecord(opts.outbound) ? opts.outbound : {};
  const approval =
    outbound.approval === "allowlist" || outbound.approval === "auto" || outbound.approval === "ask"
      ? outbound.approval
      : "ask";
  const askTimeoutMs =
    typeof outbound.askTimeoutMs === "number" &&
    Number.isFinite(outbound.askTimeoutMs) &&
    outbound.askTimeoutMs >= 0
      ? outbound.askTimeoutMs
      : DEFAULT_ASK_TIMEOUT_MS;

  const tools = isRecord(opts.tools) ? opts.tools : {};
  const vault = isRecord(opts.vault) ? opts.vault : {};

  return {
    apiKey,
    identity,
    baseUrl,
    signingKey,
    callWebsocketUrl,
    vaultKeyEnvVar: nonEmptyString(vault.keyEnvVar) ?? DEFAULT_VAULT_KEY_ENV_VAR,
    tools: {
      enable: stringArray(tools.enable),
      disable: stringArray(tools.disable),
    },
    outbound: {
      allowedRecipients: stringArray(outbound.allowedRecipients),
      approval,
      askTimeoutMs,
    },
  };
}
