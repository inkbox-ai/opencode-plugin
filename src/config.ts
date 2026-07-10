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
  gateway?: GatewayOptions;
}

// Inbound gateway mode: a long-lived process that turns inbound Inkbox
// events (email, texts, iMessage, calls) into opencode sessions and replies
// on the channel the message arrived on. Default off.
export interface GatewayOptions {
  enabled?: boolean;
  // "sidecar" (default): the gateway runs as its own process pointed at an
  // opencode server. "plugin": run inside opencode itself (requires the
  // tunnel to work under the host runtime, or a publicUrl).
  mode?: "sidecar" | "plugin";
  // Directory gateway sessions are created against. Defaults to the
  // opencode project directory (plugin mode) or cwd (sidecar mode).
  projectDirectory?: string;
  // opencode server URL for sidecar mode (e.g. http://127.0.0.1:4096).
  serverUrl?: string;
  // Local webhook server bind.
  host?: string;
  port?: number;
  // If set, skip the Inkbox tunnel and assume webhooks arrive at this URL.
  publicUrl?: string;
  // Tunnel name override; defaults to the identity handle.
  tunnelName?: string;
  // Sender allowlist. Empty + allowAllUsers=false defers to server-side
  // contact rules (the default posture).
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  // Drop inbound events whose resolved contact id is not on this list.
  allowedInboundContactIds?: string[];
  // Verify webhook signatures (default true). Disable only for local dev.
  requireSignature?: boolean;
  // Deliver verified non-Inkbox webhooks (and unverified ones) to the agent.
  externalEvents?: boolean;
  // Outbound sends from gateway sessions never prompt interactively:
  // "allowlist" enforces outbound.allowedRecipients, "auto" sends freely.
  outboundApproval?: "allowlist" | "auto";
  // How long a relayed permission question may wait for the contact's reply.
  permissionTimeoutS?: number;
  // Where inbound media files are downloaded.
  mediaDir?: string;
  // opencode agent name used for gateway sessions (carries the channel
  // prompt); the packaged "inkbox-channel" agent definition is the default.
  agent?: string;
  // Optional model override for gateway sessions, "provider/model".
  model?: string;
  // Batch rapid-fire SMS/iMessage fragments arriving within this quiet
  // window (ms) into one merged turn. 0 (default) disables batching.
  textBatchWindowMs?: number;
  // Extra per-turn directive text, keyed by contact id or channel name
  // (contact id wins). Injected under the frame tag on matching turns.
  channelPrompts?: Record<string, string>;
  // opencode agent override keyed by contact id or channel name (contact id
  // wins); falls back to the gateway-wide agent.
  channelAgents?: Record<string, string>;
  voice?: {
    enabled?: boolean;
    realtime?: {
      enabled?: boolean;
      model?: string;
      voice?: string;
      apiKeyEnvVar?: string;
      fallbackToInkboxSttTts?: boolean;
    };
  };
}

export interface ResolvedGatewayConfig {
  enabled: boolean;
  mode: "sidecar" | "plugin";
  projectDirectory?: string;
  serverUrl?: string;
  host: string;
  port: number;
  publicUrl?: string;
  tunnelName?: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  allowedInboundContactIds: string[];
  requireSignature: boolean;
  externalEvents: boolean;
  outboundApproval: "allowlist" | "auto";
  permissionTimeoutS: number;
  mediaDir?: string;
  agent?: string;
  model?: string;
  textBatchWindowMs: number;
  channelPrompts: Record<string, string>;
  channelAgents: Record<string, string>;
  voice: {
    enabled: boolean;
    realtime: {
      enabled: boolean;
      model: string;
      voice: string;
      apiKeyEnvVar: string;
      fallbackToInkboxSttTts: boolean;
    };
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
  gateway: ResolvedGatewayConfig;
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

// Keep only entries whose key and value are both non-empty strings.
function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = nonEmptyString(k);
    const val = nonEmptyString(v);
    if (key && val) out[key] = val;
  }
  return out;
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
    gateway: resolveGatewayConfig(opts.gateway, env, identity),
  };
}

function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

// Fully-defaulted gateway config (gateway disabled). Handy for tests and for
// callers that want the resolved shape without any options set.
export function defaultGatewayConfig(): ResolvedGatewayConfig {
  return resolveGatewayConfig({}, {}, undefined);
}

export const DEFAULT_GATEWAY_PORT = 8767;
export const DEFAULT_PERMISSION_TIMEOUT_S = 600;
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
export const DEFAULT_REALTIME_VOICE = "cedar";

function resolveGatewayConfig(
  options: unknown,
  env: NodeJS.ProcessEnv,
  identity: string | undefined,
): ResolvedGatewayConfig {
  const opts: GatewayOptions = isRecord(options) ? (options as GatewayOptions) : {};
  const voice = isRecord(opts.voice) ? opts.voice : {};
  const realtime = isRecord(voice.realtime) ? voice.realtime : {};
  const envAllowedUsers = nonEmptyString(env.INKBOX_ALLOWED_USERS)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled: opts.enabled === true,
    mode: opts.mode === "plugin" ? "plugin" : "sidecar",
    projectDirectory: nonEmptyString(opts.projectDirectory),
    serverUrl: nonEmptyString(opts.serverUrl) ?? nonEmptyString(env.OPENCODE_SERVER_URL),
    host: nonEmptyString(opts.host) ?? nonEmptyString(env.INKBOX_GATEWAY_HOST) ?? "127.0.0.1",
    port: numeric(opts.port) ?? numeric(env.INKBOX_GATEWAY_PORT) ?? DEFAULT_GATEWAY_PORT,
    publicUrl: nonEmptyString(opts.publicUrl) ?? nonEmptyString(env.INKBOX_PUBLIC_URL),
    // Tunnels are provisioned under the bare handle, so the default strips
    // the identity's leading "@".
    tunnelName:
      nonEmptyString(opts.tunnelName) ??
      nonEmptyString(env.INKBOX_TUNNEL_NAME) ??
      identity?.replace(/^@/, ""),
    allowedUsers: stringArray(opts.allowedUsers).length
      ? stringArray(opts.allowedUsers)
      : (envAllowedUsers ?? []),
    allowAllUsers: opts.allowAllUsers ?? boolEnv(env.INKBOX_ALLOW_ALL_USERS) ?? false,
    allowedInboundContactIds: stringArray(opts.allowedInboundContactIds),
    requireSignature: opts.requireSignature ?? boolEnv(env.INKBOX_REQUIRE_SIGNATURE) ?? true,
    externalEvents: opts.externalEvents ?? boolEnv(env.INKBOX_EXTERNAL_EVENTS_ENABLED) ?? false,
    outboundApproval: opts.outboundApproval === "auto" ? "auto" : "allowlist",
    permissionTimeoutS:
      numeric(opts.permissionTimeoutS) ??
      numeric(env.INKBOX_PERMISSION_TIMEOUT_S) ??
      DEFAULT_PERMISSION_TIMEOUT_S,
    mediaDir: nonEmptyString(opts.mediaDir) ?? nonEmptyString(env.INKBOX_OPENCODE_MEDIA_DIR),
    agent: nonEmptyString(opts.agent),
    model: nonEmptyString(opts.model),
    textBatchWindowMs:
      numeric(opts.textBatchWindowMs) ?? numeric(env.INKBOX_TEXT_BATCH_WINDOW_MS) ?? 0,
    channelPrompts: stringRecord(opts.channelPrompts),
    channelAgents: stringRecord(opts.channelAgents),
    voice: {
      enabled: voice.enabled ?? boolEnv(env.INKBOX_VOICE_ENABLED) ?? false,
      realtime: {
        enabled: realtime.enabled ?? boolEnv(env.INKBOX_REALTIME_ENABLED) ?? false,
        model:
          nonEmptyString(realtime.model) ??
          nonEmptyString(env.INKBOX_REALTIME_MODEL) ??
          DEFAULT_REALTIME_MODEL,
        voice:
          nonEmptyString(realtime.voice) ??
          nonEmptyString(env.INKBOX_REALTIME_VOICE) ??
          DEFAULT_REALTIME_VOICE,
        apiKeyEnvVar: nonEmptyString(realtime.apiKeyEnvVar) ?? "INKBOX_REALTIME_API_KEY",
        fallbackToInkboxSttTts:
          realtime.fallbackToInkboxSttTts ??
          boolEnv(env.INKBOX_REALTIME_FALLBACK_TO_INKBOX_STT_TTS) ??
          true,
      },
    },
  };
}
