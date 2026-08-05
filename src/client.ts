import { createRequire } from "node:module";
import type { AgentIdentity } from "@inkbox/sdk";
import {
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
  Inkbox,
} from "@inkbox/sdk";

const USER_AGENT_NAME = "inkbox-opencode";
const IDENTITY_RETRY_DELAYS_MS = [250, 750] as const;
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
]);

// Read at runtime rather than hardcoded so the token can't drift from the
// package version. `tsc` emits to dist/, so ../package.json resolves from
// both the build output and the source tree.
function pluginVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let cachedUserAgent: string | undefined;

/** Identifies this plugin ahead of the SDK's own `User-Agent` token. */
export function pluginUserAgent(): string {
  cachedUserAgent ??= `${USER_AGENT_NAME}/${pluginVersion()}`;
  return cachedUserAgent;
}

export interface InkboxCredentials {
  apiKey?: string;
  identity?: string;
  baseUrl?: string;
}

export interface InkboxRuntime {
  // Resolves the agent identity bound to the configured key. Cached after first call.
  getIdentity(): Promise<AgentIdentity>;
  // The underlying Inkbox client. With an agent-scoped key most admin
  // endpoints return 403 — that's fine, it just means tools that would call
  // them aren't supported in agent-scoped mode.
  getClient(): Promise<Inkbox>;
}

export interface PluginLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

export const NOT_CONFIGURED_MESSAGE =
  "Inkbox plugin is not configured. Set the INKBOX_API_KEY and INKBOX_IDENTITY environment " +
  "variables (or pass apiKey/identity as plugin options in opencode.json). " +
  "Get credentials at https://inkbox.ai/console.";

type ConfigSource = InkboxCredentials | (() => InkboxCredentials);

function readCredentials(source: ConfigSource): InkboxCredentials {
  return typeof source === "function" ? source() : source;
}

function runtimeCacheKey(cfg: InkboxCredentials): string {
  return JSON.stringify({
    apiKey: cfg.apiKey ?? "",
    identity: cfg.identity ?? "",
    baseUrl: cfg.baseUrl ?? "",
  });
}

function isTransientIdentityError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const value = current as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      message?: unknown;
    };
    const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
    if (TRANSIENT_NETWORK_CODES.has(code)) return true;

    const status = Number(value.status ?? value.statusCode);
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;

    const message = typeof value.message === "string" ? value.message : String(current);
    if (
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH)\b/i.test(message) ||
      /(?:socket hang up|network connection was lost|fetch failed)/i.test(message)
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

export async function resolveIdentityWithRetry<T>(
  resolveIdentity: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await resolveIdentity();
    } catch (error) {
      const delayMs = IDENTITY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientIdentityError(error)) throw error;
      await wait(delayMs);
    }
  }
}

// Build a lazy-cached runtime. The Inkbox SDK client and the identity
// resolution happen on first tool call, not at plugin load. This keeps
// startup cheap when a session never invokes an Inkbox tool.
export function createInkboxRuntime(source: ConfigSource, logger?: PluginLogger): InkboxRuntime {
  let resolved: {
    key: string;
    promise: Promise<{ inkbox: Inkbox; identity: AgentIdentity }>;
  } | null = null;

  function resolve(): Promise<{ inkbox: Inkbox; identity: AgentIdentity }> {
    const cfg = readCredentials(source);
    if (!cfg.apiKey || !cfg.identity) {
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    const key = runtimeCacheKey(cfg);
    if (!resolved || resolved.key !== key) {
      const inkbox = new Inkbox({
        apiKey: cfg.apiKey,
        userAgentPrefix: pluginUserAgent(),
        ...(cfg.baseUrl?.trim() ? { baseUrl: cfg.baseUrl.trim() } : {}),
      });
      const identityHandle = cfg.identity;
      const promise = (async () => {
        // Confirm the key shape before we go any further. Agent-scoped is the
        // expected mode; admin-scoped works for outbound but we surface a
        // warning since access-scoped reads assume the agent-scoped pattern.
        try {
          const info = await inkbox.whoami();
          if (info.authType === "api_key") {
            const sub = info.authSubtype;
            const isAgentScoped =
              sub === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED ||
              sub === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED;
            if (!isAgentScoped) {
              logger?.warn?.(
                `Inkbox plugin: API key is not agent-scoped (subtype=${sub}). Outbound tools will work but access-scoped reads (contacts, notes, vault) may behave differently.`,
              );
            }
          } else {
            logger?.warn?.(
              `Inkbox plugin: whoami returned authType=${info.authType} — expected api_key.`,
            );
          }
        } catch (e) {
          // whoami failure isn't fatal — the first real tool call will surface
          // a clearer error. We just couldn't preflight.
          logger?.warn?.(
            `Inkbox plugin: whoami() failed during init: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        const identity = await resolveIdentityWithRetry(() => inkbox.getIdentity(identityHandle));
        return { inkbox, identity };
      })();
      const entry = {
        key,
        promise: undefined as unknown as Promise<{ inkbox: Inkbox; identity: AgentIdentity }>,
      };
      entry.promise = promise.catch((e) => {
        // Reset so a fresh call can retry (e.g. after a transient failure),
        // but only if a newer entry hasn't already replaced this one.
        if (resolved === entry) resolved = null;
        throw e;
      });
      resolved = entry;
    }
    return resolved.promise;
  }

  return {
    async getIdentity() {
      return (await resolve()).identity;
    },
    async getClient() {
      return (await resolve()).inkbox;
    },
  };
}
