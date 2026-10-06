import { z } from "zod";
import { runTool } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

const credentialsListArgs = {
  type: z
    .enum(["login", "api_key", "key_pair", "ssh_key", "other"])
    .describe("Filter by secret type. Omit for all types.")
    .optional(),
};

const getLoginArgs = {
  secretId: z.string().describe("UUID of the login secret."),
};

const getApiKeyArgs = {
  secretId: z.string().describe("UUID of the API-key secret."),
};

const getSshKeyArgs = {
  secretId: z.string().describe("UUID of the SSH-key secret."),
};

const totpCodeArgs = {
  secretId: z.string().describe("UUID of the login secret whose TOTP code is wanted."),
};

type CredentialsListArgs = z.infer<z.ZodObject<typeof credentialsListArgs>>;
type GetLoginArgs = z.infer<z.ZodObject<typeof getLoginArgs>>;
type GetApiKeyArgs = z.infer<z.ZodObject<typeof getApiKeyArgs>>;
type GetSshKeyArgs = z.infer<z.ZodObject<typeof getSshKeyArgs>>;
type TotpCodeArgs = z.infer<z.ZodObject<typeof totpCodeArgs>>;

// Credential and TOTP tools. All disabled by default — the user must enable
// them explicitly, and the plaintext reads are additionally marked sensitive
// so they can only be enabled by exact tool name. Payloads are gated behind
// per-type get_* tools, so the agent can't surface secrets just by listing.
export function vaultTools(deps: ToolDeps): RegisteredTool[] {
  const { runtime, vault } = deps;
  return [
    {
      name: "inkbox_credentials_list",
      group: "vault",
      defaultEnabled: false,
      definition: {
        description:
          "List credentials this identity has access to. Returns metadata only (id, name, secretType) — never plaintext. To read a secret's contents, call inkbox_credentials_get_login / _get_api_key / _get_ssh_key.",
        args: credentialsListArgs,
        async execute(args: CredentialsListArgs, _ctx) {
          return runTool(async () => {
            const client = await runtime.getClient();
            const items = await client.vault.listSecrets({ secretType: args.type });
            const identity = await runtime.getIdentity();
            const safe = items
              .filter((c) => c.access.some((rule) => rule.identityId === identity.id))
              .map((c) => ({
                id: c.id,
                name: c.name,
                secretType: c.secretType,
                description: c.description,
              }));
            return formatWithHeader(`Returned ${safe.length} credential(s).`, safe);
          });
        },
      },
    },
    {
      name: "inkbox_credentials_get_login",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
      definition: {
        description:
          "Fetch a login credential (username + password + optional URL) by secret UUID. Returns plaintext — only call when you actually need the credentials to act.",
        args: getLoginArgs,
        async execute(args: GetLoginArgs, _ctx) {
          return runTool(async () => {
            const creds = await vault.getCredentials();
            const login = await creds.getLogin(args.secretId);
            return formatJson(login);
          });
        },
      },
    },
    {
      name: "inkbox_credentials_get_api_key",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
      definition: {
        description:
          "Fetch an API-key credential by secret UUID. Returns plaintext apiKey + optional endpoint/notes.",
        args: getApiKeyArgs,
        async execute(args: GetApiKeyArgs, _ctx) {
          return runTool(async () => {
            const creds = await vault.getCredentials();
            const apiKey = await creds.getApiKey(args.secretId);
            return formatJson(apiKey);
          });
        },
      },
    },
    {
      name: "inkbox_credentials_get_ssh_key",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
      definition: {
        description:
          "Fetch an SSH key credential by secret UUID. Returns plaintext private key + optional public key, fingerprint, and passphrase.",
        args: getSshKeyArgs,
        async execute(args: GetSshKeyArgs, _ctx) {
          return runTool(async () => {
            const creds = await vault.getCredentials();
            const sshKey = await creds.getSshKey(args.secretId);
            return formatJson(sshKey);
          });
        },
      },
    },
    {
      name: "inkbox_credentials_get_secret",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
      definition: {
        description:
          "Fetch one explicitly needed credential by UUID, including key_pair and other types. Returns plaintext; login TOTP seed/configuration is removed and replaced by has_totp. Never enumerate plaintext.",
        args: { secretId: z.string().min(1).describe("UUID selected from metadata listing.") },
        async execute(args: { secretId: string }) {
          return runTool(async () =>
            formatJson(await (await vault.getCredentials()).getSecret(args.secretId)),
          );
        },
      },
    },
    {
      name: "inkbox_totp_code",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
      definition: {
        description:
          "Generate a current TOTP code for a login credential that has TOTP configured. Returns the 6-digit code plus seconds remaining until expiry.",
        args: totpCodeArgs,
        async execute(args: TotpCodeArgs, _ctx) {
          return runTool(async () => {
            const creds = await vault.getCredentials();
            const code = await creds.getTotpCode(args.secretId);
            return `TOTP code for secret ${args.secretId}: ${code.code} (expires in ${code.secondsRemaining}s)`;
          });
        },
      },
    },
  ];
}
