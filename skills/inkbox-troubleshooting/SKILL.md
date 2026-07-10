---
name: inkbox-troubleshooting
description: Use when an Inkbox tool reports runtime/config errors such as "Inkbox plugin is not configured", "whoami failed", "Vault is locked", "recipient_not_opted_in", a missing/disabled tool, or phone/mailbox readiness failures. Helps recover from misconfiguration and tool errors, not first-time setup walkthroughs.
---

# Inkbox troubleshooting

Use this skill when an Inkbox tool fails, the user asks why Inkbox is not working, or a readiness problem blocks email, SMS, calls, contacts, notes, or vault access.

Start with `inkbox_doctor` (default-enabled). It reports config presence, API reachability, key scope, identity resolution, vault-key presence, and which tools are enabled or disabled — usually enough to pinpoint the failure.

## Common errors

| Error | Fix |
|---|---|
| `Inkbox plugin is not configured` | Set `INKBOX_API_KEY` + `INKBOX_IDENTITY` in the environment launching opencode, or pass `apiKey`/`identity` as plugin options in opencode.json (`~/.inkbox/config` is also read, at lowest precedence). Restart opencode after changes. |
| Tool not found / not available | The tool is opt-in and not enabled. Add its exact name (or its group) to `tools.enable` in opencode.json, then restart: `"plugin": [["@inkbox/opencode-plugin", { "tools": { "enable": ["inkbox_..."] } }]]`. Check `inkbox_doctor` for the enabled/disabled list. |
| `whoami failed: 401 Unauthorized` | API key is wrong, revoked, or has a typo. Ask the user to mint or paste a fresh key. |
| `API key is not agent-scoped` | Outbound may work, but access-scoped reads (contacts, notes, vault) can behave differently. Prefer an agent-scoped key bound to the configured identity. |
| `404` on identity resolution | The configured `identity` handle does not exist under this key or does not match the key's bound identity. |
| `sender_sms_pending` | The Inkbox phone number is still propagating to carriers. Retry later and verify `smsStatus`. |
| `recipient_not_opted_in` | Ask the recipient to text `START` to the agent's Inkbox number, then retry. |
| `recipient_opted_out` | The recipient texted `STOP`; they must text `START` again before SMS can be sent. |
| `Vault is locked` | Export `INKBOX_VAULT_KEY=<the vault key>` in the shell launching opencode (or the custom env var configured via the `vault.keyEnvVar` plugin option), then restart opencode. |

## Vault unlock pattern

Vault tools are opt-in: the `vault` group enables `inkbox_credentials_list`, but the four plaintext-returning tools must each be enabled by exact name — a group enable never turns them on. The plugin never persists the vault key. It reads the key once on first credential access from `INKBOX_VAULT_KEY`, or from the custom env var configured under `vault.keyEnvVar`.

If vault access fails, do not ask for the vault key in chat. Tell the user which env var needs to be set in the shell that launches opencode.

## Identity checks

Use `inkbox_whoami` when you need to confirm the active Inkbox identity, mailbox, phone number, SMS status, auth subtype, sending domain, or incoming-call action.

If `inkbox_whoami` fails, surface the exact error and run `inkbox_doctor` for a fuller diagnostic pass.

## When you need more

If a config field, error message, or setup flow here does not match what the user is seeing, go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of Inkbox docs.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.
