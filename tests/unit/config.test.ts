import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_VAULT_KEY_ENV_VAR,
  resolveConfig,
} from "../../src/config.js";

// Point the config-file fallback at a nonexistent HOME so these tests never
// pick up a developer's real ~/.inkbox/config.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/nonexistent/inkbox-test-home" };
});

const FULL_ENV: NodeJS.ProcessEnv = {
  INKBOX_API_KEY: "env-key",
  INKBOX_IDENTITY: "env-id",
  INKBOX_BASE_URL: "https://env.example",
  INKBOX_SIGNING_KEY: "env-sign",
};

describe("resolveConfig", () => {
  it("prefers plugin options over environment variables", () => {
    const cfg = resolveConfig(
      {
        apiKey: "opt-key",
        identity: "opt-id",
        baseUrl: "https://opt.example",
        signingKey: "opt-sign",
      },
      FULL_ENV,
    );
    expect(cfg.apiKey).toBe("opt-key");
    expect(cfg.identity).toBe("opt-id");
    expect(cfg.baseUrl).toBe("https://opt.example");
    expect(cfg.signingKey).toBe("opt-sign");
  });

  it("falls back to environment variables when options omit a value", () => {
    const cfg = resolveConfig({}, FULL_ENV);
    expect(cfg.apiKey).toBe("env-key");
    expect(cfg.identity).toBe("env-id");
    expect(cfg.baseUrl).toBe("https://env.example");
    expect(cfg.signingKey).toBe("env-sign");
  });

  it("treats blank options and env values as unset", () => {
    const cfg = resolveConfig({ apiKey: "   " }, { INKBOX_API_KEY: "", INKBOX_IDENTITY: "  " });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.identity).toBeUndefined();
  });

  it("ignores non-object options", () => {
    for (const options of [undefined, null, "garbage", 42]) {
      const cfg = resolveConfig(options, FULL_ENV);
      expect(cfg.apiKey).toBe("env-key");
      expect(cfg.identity).toBe("env-id");
    }
  });

  describe("identity env fallbacks", () => {
    it("prefers INKBOX_IDENTITY over the agent-specific variables", () => {
      const cfg = resolveConfig(
        {},
        {
          INKBOX_IDENTITY: "primary",
          INKBOX_AGENT_IDENTITY: "secondary",
          INKBOX_AGENT_HANDLE: "tertiary",
        },
      );
      expect(cfg.identity).toBe("primary");
    });

    it("falls back to INKBOX_AGENT_IDENTITY before INKBOX_AGENT_HANDLE", () => {
      const cfg = resolveConfig(
        {},
        { INKBOX_AGENT_IDENTITY: "secondary", INKBOX_AGENT_HANDLE: "tertiary" },
      );
      expect(cfg.identity).toBe("secondary");
    });

    it("uses INKBOX_AGENT_HANDLE when nothing else is set", () => {
      const cfg = resolveConfig({}, { INKBOX_AGENT_HANDLE: "tertiary" });
      expect(cfg.identity).toBe("tertiary");
    });
  });

  describe("outbound settings", () => {
    it('defaults to approval "ask" with a 5-minute ask timeout and an open allowlist', () => {
      const cfg = resolveConfig({}, FULL_ENV);
      expect(cfg.outbound.approval).toBe("ask");
      expect(cfg.outbound.askTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
      expect(cfg.outbound.askTimeoutMs).toBe(300_000);
      expect(cfg.outbound.allowedRecipients).toEqual([]);
    });

    it("accepts explicit approval mode, timeout, and allowlist", () => {
      const cfg = resolveConfig(
        {
          outbound: {
            approval: "allowlist",
            askTimeoutMs: 1234,
            allowedRecipients: [" a@x.com ", "", "+15550001111"],
          },
        },
        FULL_ENV,
      );
      expect(cfg.outbound.approval).toBe("allowlist");
      expect(cfg.outbound.askTimeoutMs).toBe(1234);
      expect(cfg.outbound.allowedRecipients).toEqual(["a@x.com", "+15550001111"]);
    });

    it("keeps a zero timeout (no deadline) but rejects negative or non-finite values", () => {
      const zero = resolveConfig({ outbound: { askTimeoutMs: 0 } }, FULL_ENV);
      expect(zero.outbound.askTimeoutMs).toBe(0);
      const negative = resolveConfig({ outbound: { askTimeoutMs: -5 } }, FULL_ENV);
      expect(negative.outbound.askTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
      const nan = resolveConfig({ outbound: { askTimeoutMs: Number.NaN } }, FULL_ENV);
      expect(nan.outbound.askTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
    });

    it('falls back to "ask" for unknown approval values', () => {
      const cfg = resolveConfig({ outbound: { approval: "yolo" } }, FULL_ENV);
      expect(cfg.outbound.approval).toBe("ask");
    });
  });

  describe("tool gating arrays", () => {
    it("defaults tools.enable and tools.disable to empty arrays", () => {
      const cfg = resolveConfig({}, FULL_ENV);
      expect(cfg.tools).toEqual({ enable: [], disable: [] });
    });

    it("normalizes entries: trims strings, drops blanks and non-strings", () => {
      const cfg = resolveConfig(
        {
          tools: {
            enable: ["email", "  inkbox_send_sms  ", "", 42],
            disable: "not-an-array",
          },
        },
        FULL_ENV,
      );
      expect(cfg.tools.enable).toEqual(["email", "inkbox_send_sms"]);
      expect(cfg.tools.disable).toEqual([]);
    });
  });

  describe("vault key env var", () => {
    it("defaults to INKBOX_VAULT_KEY", () => {
      const cfg = resolveConfig({}, FULL_ENV);
      expect(cfg.vaultKeyEnvVar).toBe(DEFAULT_VAULT_KEY_ENV_VAR);
      expect(cfg.vaultKeyEnvVar).toBe("INKBOX_VAULT_KEY");
    });

    it("honors vault.keyEnvVar", () => {
      const cfg = resolveConfig({ vault: { keyEnvVar: "MY_VAULT_KEY" } }, FULL_ENV);
      expect(cfg.vaultKeyEnvVar).toBe("MY_VAULT_KEY");
    });
  });

  describe("callWebsocketUrl", () => {
    it("resolves from the plugin option", () => {
      const cfg = resolveConfig({ callWebsocketUrl: "wss://opt.example/audio" }, FULL_ENV);
      expect(cfg.callWebsocketUrl).toBe("wss://opt.example/audio");
    });

    it("resolves from INKBOX_CALL_WEBSOCKET_URL when the option is absent", () => {
      const cfg = resolveConfig(
        {},
        { ...FULL_ENV, INKBOX_CALL_WEBSOCKET_URL: "wss://env.example/audio" },
      );
      expect(cfg.callWebsocketUrl).toBe("wss://env.example/audio");
    });

    it("prefers the option over the env var and is undefined when neither is set", () => {
      const both = resolveConfig(
        { callWebsocketUrl: "wss://opt.example/audio" },
        { ...FULL_ENV, INKBOX_CALL_WEBSOCKET_URL: "wss://env.example/audio" },
      );
      expect(both.callWebsocketUrl).toBe("wss://opt.example/audio");
      const neither = resolveConfig({}, FULL_ENV);
      expect(neither.callWebsocketUrl).toBeUndefined();
    });
  });
});
