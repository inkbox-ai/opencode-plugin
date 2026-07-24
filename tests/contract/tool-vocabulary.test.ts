// The advertised tool surface is a compatibility contract: names, groups,
// default-enabled state, and the sensitive set. Renaming or re-gating a tool
// is a breaking change and must show up here as a deliberate diff.
import { describe, expect, it } from "vitest";
import { defaultGatewayConfig } from "../../src/config.js";
import { buildAllTools } from "../../src/tools/index.js";
import type { ToolDeps } from "../../src/tools/types.js";

function stubDeps(): ToolDeps {
  return {
    runtime: {
      getIdentity: async () => {
        throw new Error("stub");
      },
      getClient: async () => {
        throw new Error("stub");
      },
    },
    config: {
      vaultKeyEnvVar: "INKBOX_VAULT_KEY",
      tools: { enable: [], disable: [] },
      outbound: { allowedRecipients: [], approval: "ask", askTimeoutMs: 0 },
      gateway: defaultGatewayConfig(),
    },
    vault: {
      keyEnvVar: "INKBOX_VAULT_KEY",
      getCredentials: async () => {
        throw new Error("stub");
      },
    },
  } as ToolDeps;
}

const DEFAULT_ENABLED = [
  "inkbox_a2a_call",
  "inkbox_a2a_check",
  "inkbox_a2a_reply",
  "inkbox_a2a_complete",
  "inkbox_a2a_ask_caller",
  "inkbox_a2a_fail",
  "inkbox_send_email",
  "inkbox_send_sms",
  "inkbox_send_imessage",
  "inkbox_list_unread_emails",
  "inkbox_list_emails",
  "inkbox_get_email",
  "inkbox_get_email_thread",
  "inkbox_list_text_conversations",
  "inkbox_get_text_conversation",
  "inkbox_list_imessage_conversations",
  "inkbox_get_imessage_conversation",
  "inkbox_list_calls",
  "inkbox_list_call_transcripts",
  "inkbox_lookup_contact",
  "inkbox_get_contact",
  "inkbox_list_contacts",
  "inkbox_create_contact",
  "inkbox_update_contact",
  "inkbox_delete_contact",
  "inkbox_list_notes",
  "inkbox_get_note",
  "inkbox_create_note",
  "inkbox_list_mail_contact_rules",
  "inkbox_list_phone_contact_rules",
  "inkbox_list_imessage_contact_rules",
  "inkbox_whoami",
  "inkbox_doctor",
].sort();

const OPT_IN = [
  "inkbox_mark_emails_read",
  "inkbox_forward_email",
  "inkbox_list_texts",
  "inkbox_get_text",
  "inkbox_mark_text_read",
  "inkbox_mark_text_conversation_read",
  "inkbox_imessage_triage_number",
  "inkbox_list_imessage_assignments",
  "inkbox_send_imessage_reaction",
  "inkbox_mark_imessage_conversation_read",
  "inkbox_place_call",
  "inkbox_update_note",
  "inkbox_delete_note",
  "inkbox_list_note_access",
  "inkbox_grant_note_access",
  "inkbox_revoke_note_access",
  "inkbox_credentials_list",
  "inkbox_credentials_get_login",
  "inkbox_credentials_get_api_key",
  "inkbox_credentials_get_ssh_key",
  "inkbox_totp_code",
].sort();

const SENSITIVE = [
  "inkbox_credentials_get_login",
  "inkbox_credentials_get_api_key",
  "inkbox_credentials_get_ssh_key",
  "inkbox_totp_code",
].sort();

const GROUPS = [
  "a2a",
  "email",
  "sms",
  "imessage",
  "calls",
  "contacts",
  "notes",
  "contact-rules",
  "access",
  "vault",
  "diagnostics",
].sort();

describe("tool vocabulary", () => {
  const all = buildAllTools(stubDeps());

  it("ships exactly the expected 54 tools", () => {
    const names = all.map((t) => t.name).sort();
    expect(names).toEqual([...DEFAULT_ENABLED, ...OPT_IN].sort());
    expect(names).toHaveLength(54);
  });

  it("has no duplicate tool names", () => {
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("default-enables exactly the core set", () => {
    const enabled = all
      .filter((t) => t.defaultEnabled)
      .map((t) => t.name)
      .sort();
    expect(enabled).toEqual(DEFAULT_ENABLED);
  });

  it("marks exactly the plaintext credential reads as sensitive", () => {
    const sensitive = all
      .filter((t) => t.sensitive)
      .map((t) => t.name)
      .sort();
    expect(sensitive).toEqual(SENSITIVE);
    for (const t of all.filter((x) => x.sensitive)) {
      expect(t.defaultEnabled).toBe(false);
    }
  });

  it("uses only the documented groups", () => {
    const groups = [...new Set(all.map((t) => t.group))].sort();
    expect(groups).toEqual(GROUPS);
  });

  it("every tool has a non-empty description and an args shape", () => {
    for (const t of all) {
      expect(t.definition.description.length, t.name).toBeGreaterThan(20);
      expect(t.definition.args, t.name).toBeDefined();
      expect(typeof t.definition.execute, t.name).toBe("function");
    }
  });
});
