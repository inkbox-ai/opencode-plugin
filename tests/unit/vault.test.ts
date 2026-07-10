import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import type { ToolDeps } from "../../src/tools/types.js";
import { vaultTools } from "../../src/tools/vault.js";

const loginCred = {
  id: "cred-login",
  name: "Prod DB",
  secretType: "login",
  description: "Primary database login",
  payload: { username: "root", password: "hunter2" },
};

const apiKeyCred = {
  id: "cred-api",
  name: "Weather API",
  secretType: "api_key",
  description: "Forecast service key",
  payload: { apiKey: "sk-secret-123" },
};

function makeCredentials() {
  return {
    list: vi.fn(() => [loginCred, apiKeyCred]),
    listLogins: vi.fn(() => [loginCred]),
    listApiKeys: vi.fn(() => [apiKeyCred]),
    listKeyPairs: vi.fn(() => []),
    listSshKeys: vi.fn(() => []),
    getLogin: vi.fn(() => ({
      id: "cred-login",
      username: "root",
      password: "hunter2",
      url: "https://db.example.com",
    })),
    getApiKey: vi.fn(() => ({
      id: "cred-api",
      apiKey: "sk-secret-123",
      endpoint: "https://api.example.com",
    })),
    getSshKey: vi.fn(() => ({
      id: "cred-ssh",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      publicKey: "ssh-ed25519 AAAA",
      fingerprint: "SHA256:abcdef",
    })),
  };
}

function makeDeps(
  credentials: Record<string, unknown>,
  identityStub: Record<string, unknown> = {},
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => ({})),
  };
  const config = {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    ...overrides,
  };
  const vault = {
    keyEnvVar: "INKBOX_VAULT_KEY",
    getCredentials: vi.fn(async () => credentials),
  };
  return { runtime, config, vault } as unknown as ToolDeps;
}

function makeCtx() {
  return { ask: vi.fn(async () => {}), abort: new AbortController().signal } as any;
}

function findTool(tools: ReturnType<typeof vaultTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("vaultTools", () => {
  it("registers the five vault tools in the vault group", () => {
    const tools = vaultTools(makeDeps(makeCredentials()));
    expect(tools.map((t) => t.name)).toEqual([
      "inkbox_credentials_list",
      "inkbox_credentials_get_login",
      "inkbox_credentials_get_api_key",
      "inkbox_credentials_get_ssh_key",
      "inkbox_totp_code",
    ]);
    for (const tool of tools) {
      expect(tool.group).toBe("vault");
    }
  });

  it("keeps every vault tool opt-in", () => {
    const tools = vaultTools(makeDeps(makeCredentials()));
    for (const tool of tools) {
      expect(tool.defaultEnabled).toBe(false);
    }
  });

  it("marks only the plaintext reads as sensitive", () => {
    const tools = vaultTools(makeDeps(makeCredentials()));
    expect(findTool(tools, "inkbox_credentials_list").sensitive).toBeFalsy();
    expect(findTool(tools, "inkbox_credentials_get_login").sensitive).toBe(true);
    expect(findTool(tools, "inkbox_credentials_get_api_key").sensitive).toBe(true);
    expect(findTool(tools, "inkbox_credentials_get_ssh_key").sensitive).toBe(true);
    expect(findTool(tools, "inkbox_totp_code").sensitive).toBe(true);
  });

  describe("inkbox_credentials_list", () => {
    it("lists all credentials without a filter and reports the count", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_list");
      const result = await tool.definition.execute({}, makeCtx());
      expect(credentials.list).toHaveBeenCalled();
      const text = outputText(result);
      expect(text).toContain("Returned 2 credential(s).");
      expect(text).toContain('"id": "cred-login"');
      expect(text).toContain('"secretType": "api_key"');
    });

    it("never includes plaintext payloads in the listing", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_list");
      const text = outputText(await tool.definition.execute({}, makeCtx()));
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("sk-secret-123");
      expect(text).not.toContain("payload");
    });

    it("uses the typed list for each secret-type filter", async () => {
      const cases = [
        ["login", "listLogins"],
        ["api_key", "listApiKeys"],
        ["key_pair", "listKeyPairs"],
        ["ssh_key", "listSshKeys"],
      ] as const;
      for (const [type, method] of cases) {
        const credentials = makeCredentials();
        const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_list");
        await tool.definition.execute({ type }, makeCtx());
        expect(credentials[method]).toHaveBeenCalled();
        expect(credentials.list).not.toHaveBeenCalled();
      }
    });

    it("falls back to the full list for the other filter", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_list");
      await tool.definition.execute({ type: "other" }, makeCtx());
      expect(credentials.list).toHaveBeenCalled();
      expect(credentials.listLogins).not.toHaveBeenCalled();
    });

    it("declares a schema with an optional type filter", () => {
      const tool = findTool(vaultTools(makeDeps(makeCredentials())), "inkbox_credentials_list");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ type: "login" }).success).toBe(true);
      expect(schema.safeParse({ type: "ssh_key" }).success).toBe(true);
      expect(schema.safeParse({ type: "password" }).success).toBe(false);
    });
  });

  describe("inkbox_credentials_get_login", () => {
    it("fetches the login secret and returns its plaintext fields", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_get_login");
      const result = await tool.definition.execute({ secretId: "cred-login" }, makeCtx());
      expect(credentials.getLogin).toHaveBeenCalledWith("cred-login");
      const text = outputText(result);
      expect(text).toContain('"username": "root"');
      expect(text).toContain('"password": "hunter2"');
    });

    it("declares a schema that requires secretId", () => {
      const tool = findTool(
        vaultTools(makeDeps(makeCredentials())),
        "inkbox_credentials_get_login",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ secretId: "cred-login" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ secretId: 42 }).success).toBe(false);
    });
  });

  describe("inkbox_credentials_get_api_key", () => {
    it("fetches the API-key secret and returns its plaintext fields", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_get_api_key");
      const result = await tool.definition.execute({ secretId: "cred-api" }, makeCtx());
      expect(credentials.getApiKey).toHaveBeenCalledWith("cred-api");
      const text = outputText(result);
      expect(text).toContain('"apiKey": "sk-secret-123"');
      expect(text).toContain('"endpoint": "https://api.example.com"');
    });

    it("declares a schema that requires secretId", () => {
      const tool = findTool(
        vaultTools(makeDeps(makeCredentials())),
        "inkbox_credentials_get_api_key",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ secretId: "cred-api" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe("inkbox_credentials_get_ssh_key", () => {
    it("fetches the SSH-key secret and returns its plaintext fields", async () => {
      const credentials = makeCredentials();
      const tool = findTool(vaultTools(makeDeps(credentials)), "inkbox_credentials_get_ssh_key");
      const result = await tool.definition.execute({ secretId: "cred-ssh" }, makeCtx());
      expect(credentials.getSshKey).toHaveBeenCalledWith("cred-ssh");
      const text = outputText(result);
      expect(text).toContain('"privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----"');
      expect(text).toContain('"fingerprint": "SHA256:abcdef"');
    });

    it("declares a schema that requires secretId", () => {
      const tool = findTool(
        vaultTools(makeDeps(makeCredentials())),
        "inkbox_credentials_get_ssh_key",
      );
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ secretId: "cred-ssh" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe("inkbox_totp_code", () => {
    it("unlocks the vault, then generates the code via the identity", async () => {
      const identity = {
        getTotpCode: vi.fn(async () => ({ code: "123456", secondsRemaining: 17 })),
      };
      const deps = makeDeps(makeCredentials(), identity);
      const tool = findTool(vaultTools(deps), "inkbox_totp_code");
      const result = await tool.definition.execute({ secretId: "cred-login" }, makeCtx());
      expect(deps.vault.getCredentials).toHaveBeenCalled();
      expect(identity.getTotpCode).toHaveBeenCalledWith("cred-login");
      const text = outputText(result);
      expect(text).toContain("TOTP code for secret cred-login: 123456");
      expect(text).toContain("(expires in 17s)");
    });

    it("surfaces the locked-vault error without generating a code", async () => {
      const identity = {
        getTotpCode: vi.fn(async () => ({ code: "123456", secondsRemaining: 17 })),
      };
      const deps = makeDeps(makeCredentials(), identity);
      (deps.vault as { getCredentials: unknown }).getCredentials = vi.fn(async () => {
        throw new Error(
          "Vault is locked. Set the INKBOX_VAULT_KEY environment variable to the vault unlock key.",
        );
      });
      const tool = findTool(vaultTools(deps), "inkbox_totp_code");
      await expect(tool.definition.execute({ secretId: "cred-login" }, makeCtx())).rejects.toThrow(
        /Vault is locked/,
      );
      expect(identity.getTotpCode).not.toHaveBeenCalled();
    });

    it("declares a schema that requires secretId", () => {
      const tool = findTool(vaultTools(makeDeps(makeCredentials())), "inkbox_totp_code");
      const schema = z.object(tool.definition.args);
      expect(schema.safeParse({ secretId: "cred-login" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ secretId: 42 }).success).toBe(false);
    });
  });
});
