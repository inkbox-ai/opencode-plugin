// Webhook source registry. Each provider fingerprints inbound requests by
// its signature header and verifies the raw body against its own scheme.
// Verification always fails closed: no secret or a bad signature => false.

import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyWebhook } from "@inkbox/sdk";
import type { ResolvedConfig } from "../config.js";
import type { WebhookProvider } from "./types.js";

const INKBOX_SIGNATURE_HEADER = "x-inkbox-signature";
const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

// The webhook server hands us lowercased header names, but names are
// case-insensitive on the wire, so tolerate non-normalized maps too.
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

type InkboxVerifyFn = typeof verifyWebhook;

// The SDK owns the canonical Inkbox HMAC scheme (an HMAC-SHA256 over the
// request id, timestamp, and raw body, keyed by the identity's signing
// key). The verifier is injectable so tests can observe the delegation.
export function createInkboxProvider(verify: InkboxVerifyFn = verifyWebhook): WebhookProvider {
  return {
    name: "inkbox",
    matches(headers) {
      return headerValue(headers, INKBOX_SIGNATURE_HEADER) !== undefined;
    },
    verify({ body, headers, secret }) {
      if (!secret) return false;
      try {
        return verify({ payload: body, headers, secret });
      } catch {
        // Malformed signatures can throw (e.g. digest length mismatch).
        return false;
      }
    },
    secretEnvVar() {
      // Inkbox verifies with the configured signing key, not an env var.
      return undefined;
    },
  };
}

export const inkboxProvider: WebhookProvider = createInkboxProvider();

// GitHub signs the raw request body as an HMAC-SHA256 keyed by the webhook
// secret and sends it as `X-Hub-Signature-256: sha256=<hex>`.
export const githubProvider: WebhookProvider = {
  name: "github",
  matches(headers) {
    return headerValue(headers, GITHUB_SIGNATURE_HEADER) !== undefined;
  },
  verify({ body, headers, secret }) {
    if (!secret) return false;
    const sent = headerValue(headers, GITHUB_SIGNATURE_HEADER) ?? "";
    if (!sent.startsWith("sha256=")) return false;
    const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
    const received = Buffer.from(sent.slice("sha256=".length));
    if (expected.length !== received.length) return false;
    // Constant-time compare so a bad signature can't be timing-probed.
    return timingSafeEqual(expected, received);
  },
  secretEnvVar() {
    return "INKBOX_WEBHOOK_SECRET_GITHUB";
  },
};

// Match order is first-match-wins: Inkbox's own events take precedence,
// then bundled third parties, then caller-supplied extras.
export const defaultProviders: readonly WebhookProvider[] = [inkboxProvider, githubProvider];

// Returns the first provider whose signature header is present, or
// undefined when no registered source claims the request.
export function matchProvider(
  headers: Record<string, string>,
  extra: WebhookProvider[] = [],
): WebhookProvider | undefined {
  for (const provider of [...defaultProviders, ...extra]) {
    if (provider.matches(headers)) return provider;
  }
  return undefined;
}

// The matched provider names the verification scheme; this maps it to its
// secret. Inkbox uses the configured signing key; every other source reads
// its declared env var, defaulting to INKBOX_WEBHOOK_SECRET_<NAME>.
// A missing/empty secret resolves to undefined, which fails verify closed.
export function resolveProviderSecret(
  provider: WebhookProvider,
  config: Pick<ResolvedConfig, "signingKey">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider.name === "inkbox") return config.signingKey;
  const envVar = provider.secretEnvVar() ?? `INKBOX_WEBHOOK_SECRET_${provider.name.toUpperCase()}`;
  const value = env[envVar];
  return value ? value : undefined;
}
