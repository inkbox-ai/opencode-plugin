import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInkboxProvider,
  defaultProviders,
  githubProvider,
  inkboxProvider,
  matchProvider,
  resolveProviderSecret,
} from "../../src/gateway/providers.js";
import type { WebhookProvider } from "../../src/gateway/types.js";

const BODY = Buffer.from('{"event_type":"message.received"}');

function githubSignature(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// Signs a request the way Inkbox does: HMAC-SHA256 over
// `<request-id>.<timestamp>.<raw body>` keyed by the (unprefixed) signing key.
function inkboxHeaders(body: Buffer, secret: string): Record<string, string> {
  const requestId = "req-123";
  const timestamp = "1751500000";
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const digest = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), body]))
    .digest("hex");
  return {
    "x-inkbox-request-id": requestId,
    "x-inkbox-timestamp": timestamp,
    "x-inkbox-signature": `sha256=${digest}`,
  };
}

function customProvider(overrides: Partial<WebhookProvider> = {}): WebhookProvider {
  return {
    name: "acme",
    matches: (headers) => "x-acme-signature" in headers,
    verify: () => true,
    secretEnvVar: () => undefined,
    ...overrides,
  };
}

describe("matchProvider", () => {
  it("routes a request carrying x-inkbox-signature to the inkbox provider", () => {
    const headers = { "x-inkbox-signature": "sha256=abc" };
    expect(matchProvider(headers)).toBe(inkboxProvider);
  });

  it("routes a request carrying x-hub-signature-256 to the github provider", () => {
    const headers = { "x-hub-signature-256": "sha256=abc" };
    expect(matchProvider(headers)).toBe(githubProvider);
  });

  it("prefers inkbox over github when both signature headers are present", () => {
    const headers = {
      "x-inkbox-signature": "sha256=abc",
      "x-hub-signature-256": "sha256=def",
    };
    expect(matchProvider(headers)).toBe(inkboxProvider);
  });

  it("returns undefined when no registered source claims the request", () => {
    const headers = { "content-type": "application/json", "x-unknown-signature": "zzz" };
    expect(matchProvider(headers)).toBeUndefined();
  });

  it("checks extra providers only after the built-in ones", () => {
    const catchAll = customProvider({ matches: () => true });
    expect(matchProvider({ "x-hub-signature-256": "sha256=abc" }, [catchAll])).toBe(githubProvider);
    expect(matchProvider({ "x-acme-signature": "v1=abc" }, [catchAll])).toBe(catchAll);
  });

  it("matches signature headers case-insensitively", () => {
    expect(matchProvider({ "X-Inkbox-Signature": "sha256=abc" })).toBe(inkboxProvider);
    expect(matchProvider({ "X-Hub-Signature-256": "sha256=abc" })).toBe(githubProvider);
  });

  it("exposes defaultProviders in precedence order: inkbox, then github", () => {
    expect(defaultProviders.map((p) => p.name)).toEqual(["inkbox", "github"]);
  });
});

describe("githubProvider", () => {
  const secret = "gh-webhook-secret";

  it("accepts a genuine HMAC-SHA256 signature over the raw body", async () => {
    const headers = { "x-hub-signature-256": githubSignature(BODY, secret) };
    expect(await githubProvider.verify({ body: BODY, headers, secret })).toBe(true);
  });

  it("rejects a signature computed over a different body", async () => {
    const headers = { "x-hub-signature-256": githubSignature(Buffer.from("tampered"), secret) };
    expect(await githubProvider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("rejects a signature computed with a different secret", async () => {
    const headers = { "x-hub-signature-256": githubSignature(BODY, "wrong-secret") };
    expect(await githubProvider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("rejects a signature that is not sha256-prefixed", async () => {
    const bare = githubSignature(BODY, secret).slice("sha256=".length);
    const headers = { "x-hub-signature-256": `sha1=${bare}` };
    expect(await githubProvider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", async () => {
    const headers = { "x-hub-signature-256": "sha256=deadbeef" };
    expect(await githubProvider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("fails closed when the secret is missing or empty", async () => {
    const headers = { "x-hub-signature-256": githubSignature(BODY, secret) };
    expect(await githubProvider.verify({ body: BODY, headers, secret: undefined })).toBe(false);
    expect(await githubProvider.verify({ body: BODY, headers, secret: "" })).toBe(false);
  });

  it("names INKBOX_WEBHOOK_SECRET_GITHUB as its secret env var", () => {
    expect(githubProvider.secretEnvVar()).toBe("INKBOX_WEBHOOK_SECRET_GITHUB");
  });
});

describe("inkboxProvider", () => {
  const secret = "whsec_signing-key";

  it("delegates verification to the SDK verifier with the raw body, headers, and secret", async () => {
    const verify = vi.fn(() => true);
    const provider = createInkboxProvider(verify);
    const headers = inkboxHeaders(BODY, secret);
    expect(await provider.verify({ body: BODY, headers, secret })).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ payload: BODY, headers, secret });
  });

  it("returns false when the SDK verifier rejects the signature", async () => {
    const provider = createInkboxProvider(vi.fn(() => false));
    const headers = inkboxHeaders(BODY, secret);
    expect(await provider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("fails closed without calling the verifier when the secret is missing", async () => {
    const verify = vi.fn(() => true);
    const provider = createInkboxProvider(verify);
    const headers = inkboxHeaders(BODY, secret);
    expect(await provider.verify({ body: BODY, headers, secret: undefined })).toBe(false);
    expect(await provider.verify({ body: BODY, headers, secret: "" })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed when the verifier throws on a malformed signature", async () => {
    const provider = createInkboxProvider(
      vi.fn(() => {
        throw new RangeError("Input buffers must have the same byte length");
      }),
    );
    const headers = { ...inkboxHeaders(BODY, secret), "x-inkbox-signature": "sha256=short" };
    expect(await provider.verify({ body: BODY, headers, secret })).toBe(false);
  });

  it("verifies a request signed with the Inkbox scheme via the default SDK verifier", async () => {
    const headers = inkboxHeaders(BODY, secret);
    expect(await inkboxProvider.verify({ body: BODY, headers, secret })).toBe(true);
    expect(await inkboxProvider.verify({ body: Buffer.from("tampered"), headers, secret })).toBe(
      false,
    );
    expect(await inkboxProvider.verify({ body: BODY, headers, secret: "whsec_other" })).toBe(false);
  });

  it("declares no secret env var: the signing key comes from config", () => {
    expect(inkboxProvider.secretEnvVar()).toBeUndefined();
  });
});

describe("resolveProviderSecret", () => {
  it("resolves the inkbox provider to the configured signing key", () => {
    const env = { INKBOX_WEBHOOK_SECRET_INKBOX: "not-this" };
    expect(resolveProviderSecret(inkboxProvider, { signingKey: "whsec_k" }, env)).toBe("whsec_k");
  });

  it("returns undefined for inkbox when no signing key is configured", () => {
    expect(resolveProviderSecret(inkboxProvider, {}, {})).toBeUndefined();
  });

  it("resolves the github provider from INKBOX_WEBHOOK_SECRET_GITHUB", () => {
    const env = { INKBOX_WEBHOOK_SECRET_GITHUB: "gh-secret" };
    expect(resolveProviderSecret(githubProvider, { signingKey: "whsec_k" }, env)).toBe("gh-secret");
  });

  it("returns undefined when the provider's env var is unset or empty", () => {
    expect(resolveProviderSecret(githubProvider, {}, {})).toBeUndefined();
    expect(
      resolveProviderSecret(githubProvider, {}, { INKBOX_WEBHOOK_SECRET_GITHUB: "" }),
    ).toBeUndefined();
  });

  it("falls back to INKBOX_WEBHOOK_SECRET_<NAME> for providers without a declared env var", () => {
    const provider = customProvider();
    const env = { INKBOX_WEBHOOK_SECRET_ACME: "acme-secret" };
    expect(resolveProviderSecret(provider, {}, env)).toBe("acme-secret");
  });

  it("honors a provider's declared secret env var over the generic pattern", () => {
    const provider = customProvider({ secretEnvVar: () => "ACME_HOOK_KEY" });
    const env = { ACME_HOOK_KEY: "declared", INKBOX_WEBHOOK_SECRET_ACME: "generic" };
    expect(resolveProviderSecret(provider, {}, env)).toBe("declared");
  });
});
