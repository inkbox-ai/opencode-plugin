import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedConfig } from "../../src/config.js";
import type { ToolDeps } from "../../src/tools/types.js";
import { whoamiTools } from "../../src/tools/whoami.js";

function makeClient(whoamiResult?: Record<string, unknown>) {
  return {
    whoami: vi.fn(
      async () =>
        whoamiResult ?? {
          authType: "api_key",
          authSubtype: "api_key_agent_scoped_claimed",
          label: "dev key",
          organizationId: "org-1",
        },
    ),
  };
}

function makeIdentity(overrides?: Record<string, unknown>) {
  return {
    agentHandle: "scout",
    id: "ident-1",
    displayName: "Scout",
    imessageEnabled: true,
    mailbox: {
      emailAddress: "scout@agents.inkbox.ai",
      sendingDomain: "agents.inkbox.ai",
      filterMode: "open",
    },
    phoneNumber: {
      number: "+15551230000",
      id: "pn-1",
      type: "local",
      smsStatus: "active",
      smsErrorCode: null,
      filterMode: "contacts_only",
      incomingCallAction: "reject",
    },
    tunnel: { publicHost: "scout.tunnel.inkbox.ai" },
    getIncomingCallAction: vi.fn(async () => ({ incomingCallAction: "voicemail" })),
    ...overrides,
  };
}

function makeDeps(
  identityStub: Record<string, unknown>,
  clientStub: Record<string, unknown> = makeClient(),
  overrides?: Partial<ResolvedConfig>,
): ToolDeps {
  const runtime = {
    getIdentity: vi.fn(async () => identityStub),
    getClient: vi.fn(async () => clientStub),
  };
  const config = {
    apiKey: "k",
    identity: "agent",
    vaultKeyEnvVar: "INKBOX_VAULT_KEY",
    tools: { enable: [], disable: [] },
    outbound: { allowedRecipients: [], approval: "auto", askTimeoutMs: 0 },
    ...overrides,
  };
  const vault = { keyEnvVar: "INKBOX_VAULT_KEY", getCredentials: vi.fn() };
  return { runtime, config, vault } as unknown as ToolDeps;
}

function makeCtx() {
  return { ask: vi.fn(async () => {}), abort: new AbortController().signal } as any;
}

function getWhoami(deps: ToolDeps) {
  const tools = whoamiTools(deps);
  const tool = tools.find((t) => t.name === "inkbox_whoami");
  if (!tool) throw new Error("tool inkbox_whoami not registered");
  return tool;
}

function outputText(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output;
}

describe("whoamiTools", () => {
  it("registers the whoami tool in the diagnostics group, enabled by default", () => {
    const tools = whoamiTools(makeDeps(makeIdentity()));
    expect(tools.map((t) => t.name)).toEqual(["inkbox_whoami"]);
    expect(tools[0].group).toBe("diagnostics");
    expect(tools[0].defaultEnabled).toBe(true);
    expect(tools[0].sensitive).toBeFalsy();
  });

  it("reports the auth context alongside the resolved identity", async () => {
    const client = makeClient();
    const tool = getWhoami(makeDeps(makeIdentity(), client));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(client.whoami).toHaveBeenCalledTimes(1);
    expect(text).toContain('"authType": "api_key"');
    expect(text).toContain('"authSubtype": "api_key_agent_scoped_claimed"');
    expect(text).toContain('"keyLabel": "dev key"');
    expect(text).toContain('"organizationId": "org-1"');
    expect(text).toContain('"handle": "scout"');
    expect(text).toContain('"emailAddress": "scout@agents.inkbox.ai"');
    expect(text).toContain('"phoneNumber": "+15551230000"');
    expect(text).toContain('"tunnelPublicHost": "scout.tunnel.inkbox.ai"');
  });

  it("labels the dedicated phone line and the shared iMessage line", async () => {
    const tool = getWhoami(makeDeps(makeIdentity()));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(text).toContain('"dedicated_phone_line": "+15551230000"');
    expect(text).toContain("origination=dedicated_number");
    expect(text).toContain('"shared_imessage_line": "enabled"');
    expect(text).toContain("origination=shared_imessage_number");
  });

  it("omits api-key-only fields when authenticated with a non-api_key credential", async () => {
    const client = makeClient({ authType: "jwt", organizationId: "org-2" });
    const tool = getWhoami(makeDeps(makeIdentity(), client));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(text).toContain('"authType": "jwt"');
    expect(text).not.toContain("authSubtype");
    expect(text).not.toContain("keyLabel");
  });

  it("prefers the identity-scoped incoming-call action over the number-scoped field", async () => {
    const identity = makeIdentity();
    const tool = getWhoami(makeDeps(identity));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(identity.getIncomingCallAction).toHaveBeenCalledTimes(1);
    expect(text).toContain('"incomingCallAction": "voicemail"');
  });

  it("falls back to the number-scoped incoming-call action when the identity-scoped surface is missing", async () => {
    const identity = makeIdentity({ getIncomingCallAction: undefined });
    const tool = getWhoami(makeDeps(identity));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(text).toContain('"incomingCallAction": "reject"');
  });

  it("reports a null incoming-call action when the identity-scoped lookup fails", async () => {
    const identity = makeIdentity({
      getIncomingCallAction: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const tool = getWhoami(makeDeps(identity));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(text).toContain('"incomingCallAction": null');
  });

  it("reports an unprovisioned phone line and a disabled iMessage line", async () => {
    const identity = makeIdentity({
      phoneNumber: null,
      imessageEnabled: false,
      getIncomingCallAction: undefined,
    });
    const tool = getWhoami(makeDeps(identity));
    const text = outputText(await tool.definition.execute({}, makeCtx()));
    expect(text).toContain('"dedicated_phone_line": "(none provisioned)"');
    expect(text).toContain('"shared_imessage_line": "disabled"');
    expect(text).toContain('"phoneNumber": null');
  });

  it("declares an empty args schema that accepts an empty object", () => {
    const tool = getWhoami(makeDeps(makeIdentity()));
    expect(Object.keys(tool.definition.args)).toHaveLength(0);
    const schema = z.object(tool.definition.args);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse("not-an-object").success).toBe(false);
  });
});
