import type { InkboxRuntime } from "./client.js";

export interface VaultRuntimeOptions {
  keyEnvVar?: string;
}

export interface FreshCredentials {
  getSecret(secretId: string): Promise<Record<string, unknown>>;
  getLogin(secretId: string): Promise<Record<string, unknown>>;
  getApiKey(secretId: string): Promise<Record<string, unknown>>;
  getSshKey(secretId: string): Promise<Record<string, unknown>>;
  getTotpCode(secretId: string): Promise<{ code: string; secondsRemaining: number }>;
}

export interface VaultRuntime {
  keyEnvVar: string;
  getCredentials(): Promise<FreshCredentials>;
}

export function createVaultRuntime(
  runtime: InkboxRuntime,
  opts: VaultRuntimeOptions = {},
): VaultRuntime {
  const keyEnvVar = opts.keyEnvVar ?? "INKBOX_OPENCODE_VAULT_KEY";
  let currentClient: Awaited<ReturnType<InkboxRuntime["getClient"]>> | undefined;
  let unlocking: Promise<FreshCredentials> | undefined;
  let currentKey: string | undefined;

  async function getCredentials(): Promise<FreshCredentials> {
    const client = await runtime.getClient();
    const key = process.env[keyEnvVar];
    if (currentClient !== client || currentKey !== key) {
      currentClient = client;
      currentKey = key;
      unlocking = undefined;
    }
    if (!key) {
      throw new Error(`Vault is locked. Set ${keyEnvVar} locally to unlock credential tools.`);
    }
    if (!unlocking) {
      const pending = (async (): Promise<FreshCredentials> => {
        const identity = await runtime.getIdentity();
        const unlocked = await client.vault.unlock(key, { identityId: identity.id });
        function assertLocalKey(): void {
          if (process.env[keyEnvVar] !== key || currentClient !== client || currentKey !== key)
            throw new Error(
              "The local Vault key changed; unlock credentials again before reading.",
            );
        }
        async function authorize(secretId: string): Promise<void> {
          assertLocalKey();
          const rules = await client.vault.listAccessRules(secretId);
          assertLocalKey();
          if (!rules.some((rule) => rule.identityId === identity.id)) {
            throw new Error("This credential is not shared with the configured identity.");
          }
        }
        async function read(secretId: string, expected?: string): Promise<Record<string, unknown>> {
          await authorize(secretId);
          const secret = await unlocked.getSecret(secretId);
          await authorize(secretId);
          if (expected && secret.secretType !== expected) {
            throw new Error(`The requested credential is not a ${expected} secret.`);
          }
          const payload = { ...secret.payload } as Record<string, unknown>;
          if (secret.secretType === "login") {
            payload.has_totp = payload.totp != null;
            delete payload.totp;
          }
          return expected ? payload : { ...secret, payload };
        }
        return {
          getSecret: (id) => read(id),
          getLogin: (id) => read(id, "login"),
          getApiKey: (id) => read(id, "api_key"),
          getSshKey: (id) => read(id, "ssh_key"),
          getTotpCode: async (id) => {
            await authorize(id);
            const code = await unlocked.getTotpCode(id);
            await authorize(id);
            return code;
          },
        };
      })();
      unlocking = pending;
      void pending.catch(() => {
        if (unlocking === pending) unlocking = undefined;
      });
    }
    return unlocking;
  }

  return { keyEnvVar, getCredentials };
}
