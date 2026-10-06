import { generateOrgEncryptionKey, generateVaultKeyMaterial, Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { vaultTools } from "../../src/tools/vault.js";
import { createVaultRuntime } from "../../src/vault.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it("lists assigned metadata while locked and never invokes credential unlock", async () => {
  const unlock = vi.fn();
  const deps: any = {
    runtime: {
      getClient: async () => ({
        vault: {
          listSecrets: async () => [
            {
              id: "mine",
              name: "Synthetic",
              secretType: "login",
              access: [{ identityId: "identity" }],
              payload: { password: "not-for-listing" },
            },
            {
              id: "other",
              name: "Not assigned",
              secretType: "login",
              access: [{ identityId: "different" }],
            },
          ],
          unlock,
        },
      }),
      getIdentity: async () => ({ id: "identity" }),
    },
    vault: { getCredentials: unlock },
  };
  const tool = vaultTools(deps).find((tool) => tool.name === "inkbox_credentials_list")!;
  const out = await tool.definition.execute({}, {} as any);
  expect(String(out)).toContain("mine");
  expect(String(out)).not.toContain("not-for-listing");
  expect(String(out)).not.toContain("Not assigned");
  expect(unlock).not.toHaveBeenCalled();
});
it("uses published SDK cryptography, fresh reads, identity grants and seed-free current TOTP", async () => {
  const key = "Synthetic-Vault-Key-123!",
    org = "11111111-1111-4111-8111-111111111111";
  const material = await generateVaultKeyMaterial(key, org, generateOrgEncryptionKey());
  const rows = new Map<string, any>();
  let allowed = true;
  let deleted = false;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const id = url.pathname.split("/").at(-1)!;
      let value: unknown;
      let status = 200;
      if (url.pathname.endsWith("/info")) value = { id: "vault", organization_id: org };
      else if (url.pathname.endsWith("/unlock"))
        value = {
          wrapped_org_encryption_key:
            url.searchParams.get("auth_hash") === material.authHash
              ? material.wrappedOrgEncryptionKey
              : null,
          encrypted_secrets: [],
        };
      else if (url.pathname.endsWith("/keys")) value = [{ id: material.id }];
      else if (url.pathname.endsWith("/access"))
        value = allowed ? [{ identity_id: "identity" }] : [];
      else if (url.pathname.endsWith("/secrets") && init?.method === "POST") {
        rows.set(body.id, {
          ...body,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          access: [{ identity_id: "identity" }],
        });
        value = rows.get(body.id);
      } else if (rows.has(id) && init?.method === "PATCH") {
        rows.set(id, { ...rows.get(id), ...body });
        value = rows.get(id);
      } else if (rows.has(id)) {
        reads++;
        status = deleted ? 404 : 200;
        value = deleted ? { detail: "Not found" } : rows.get(id);
      } else throw new Error(`Unexpected synthetic SDK route ${url.pathname}`);
      return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  // Explicit synthetic key prevents inheriting any ambient SDK key/config.
  const sdk = new Inkbox({
    apiKey: "synthetic-test-key",
    baseUrl: "https://sdk.test",
    vaultKey: key,
  });
  await sdk.ready();
  const unlocked = sdk.vault.unlocked!;
  const secret = await unlocked.createSecret({
    name: "Synthetic login",
    payload: {
      username: "synthetic",
      password: "version-one",
      totp: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", digits: 8 },
    },
  });
  const runtime: any = {
    getClient: async () => sdk,
    getIdentity: async () => ({ id: "identity" }),
  };
  const vault = createVaultRuntime(runtime, { keyEnvVar: "SYNTHETIC_VAULT_TEST_KEY" });
  await expect(vault.getCredentials()).rejects.toThrow("locked");
  vi.stubEnv("SYNTHETIC_VAULT_TEST_KEY", "wrong-synthetic-key");
  await expect(vault.getCredentials()).rejects.toThrow();
  vi.stubEnv("SYNTHETIC_VAULT_TEST_KEY", key);
  const credentials = await vault.getCredentials();
  const login = await credentials.getLogin(secret.id);
  expect(login.password).toBe("version-one");
  expect(login.has_totp).toBe(true);
  expect(login).not.toHaveProperty("totp");
  expect(JSON.stringify(login)).not.toContain("GEZDGNBV");
  await unlocked.updateSecret(secret.id, {
    payload: {
      username: "synthetic",
      password: "version-two",
      totp: { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", digits: 8 },
    },
  });
  expect((await credentials.getLogin(secret.id)).password).toBe("version-two");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1111111109000);
  const totp = await credentials.getTotpCode(secret.id);
  expect(totp.code).toBe("07081804");
  expect(totp.secondsRemaining).toBe(1);
  allowed = false;
  const before = reads;
  await expect(credentials.getLogin(secret.id)).rejects.toThrow("not shared");
  expect(reads).toBe(before);
  allowed = true;
  deleted = true;
  await expect(credentials.getLogin(secret.id)).rejects.toThrow();
}, 20000);
