# Inkbox for opencode

Give your [opencode](https://opencode.ai) agent its own [Inkbox](https://inkbox.ai)
identity: a mailbox, a dedicated phone number for SMS/MMS and voice, iMessage,
contacts, notes, and an encrypted credential vault — as native opencode tools.

`Email` · `SMS / MMS` · `iMessage` · `Calls` · `Contacts` · `Notes` · `Vault`

## Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@inkbox/opencode-plugin"]
}
```

opencode installs it automatically on next start. Credentials come from
environment variables (recommended — keys stay out of committed config):

```bash
export INKBOX_API_KEY=sk-ink-...        # agent-scoped API key
export INKBOX_IDENTITY=your-agent       # agent handle
```

Get both at [inkbox.ai/console](https://inkbox.ai/console). Alternatively pass
options with the tuple form — with `{env:VAR}` substitution so the config file
never holds the key itself:

```json
{
  "plugin": [["@inkbox/opencode-plugin", {
    "apiKey": "{env:INKBOX_API_KEY}",
    "identity": "your-agent"
  }]]
}
```

Credentials also fall back to `~/.inkbox/config` (the same `key = value` file
the Inkbox CLI and SDKs read), which is handy for processes that don't inherit
your shell's environment.

Sanity-check the setup by asking the agent to run `inkbox_doctor` — it reports
config, API reachability, key scope, the resolved identity, and which tool
groups are enabled.

## Tools

24 tools are enabled by default; 32 more are opt-in (see
[Enabling more tools](#enabling-more-tools)). Names are stable — treat renames
as breaking.

| Group | Enabled by default | Opt-in |
|---|---|---|
| `email` | `inkbox_send_email`, `inkbox_list_unread_emails`, `inkbox_list_emails`, `inkbox_get_email`, `inkbox_get_email_thread` | `inkbox_forward_email`, `inkbox_mark_emails_read` |
| `sms` | `inkbox_send_sms`, `inkbox_list_text_conversations`, `inkbox_get_text_conversation` | `inkbox_list_texts`, `inkbox_get_text`, `inkbox_mark_text_read`, `inkbox_mark_text_conversation_read` |
| `imessage` | `inkbox_send_imessage`, `inkbox_list_imessage_conversations`, `inkbox_get_imessage_conversation` | `inkbox_imessage_triage_number`, `inkbox_list_imessage_assignments`, `inkbox_send_imessage_reaction`, `inkbox_mark_imessage_conversation_read` |
| `calls` | `inkbox_list_calls`, `inkbox_list_call_transcripts` | `inkbox_place_call` |
| `contacts` | `inkbox_lookup_contact`, `inkbox_get_contact`, `inkbox_list_contacts`, `inkbox_create_contact`, `inkbox_update_contact`, `inkbox_delete_contact` | — |
| `notes` | `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note` | `inkbox_update_note`, `inkbox_delete_note` |
| `contact-rules` | — | `inkbox_list_mail_contact_rules`, `inkbox_create_mail_contact_rule`, `inkbox_update_mail_contact_rule`, `inkbox_delete_mail_contact_rule`, `inkbox_list_phone_contact_rules`, `inkbox_create_phone_contact_rule`, `inkbox_update_phone_contact_rule`, `inkbox_delete_phone_contact_rule` |
| `access` | — | `inkbox_list_contact_access`, `inkbox_grant_contact_access`, `inkbox_revoke_contact_access`, `inkbox_list_note_access`, `inkbox_grant_note_access`, `inkbox_revoke_note_access` |
| `vault` | — | `inkbox_credentials_list`, and by exact name only: `inkbox_credentials_get_login`, `inkbox_credentials_get_api_key`, `inkbox_credentials_get_ssh_key`, `inkbox_totp_code` |
| `diagnostics` | `inkbox_whoami`, `inkbox_doctor` | — |

### Enabling more tools

opencode sends every registered tool's spec to the model on each turn, so the
default surface is deliberately lean. Enable more by exact name or by group,
then restart opencode:

```json
{
  "plugin": [["@inkbox/opencode-plugin", {
    "tools": { "enable": ["inkbox_place_call", "contact-rules"] }
  }]]
}
```

- `tools.enable` / `tools.disable` accept tool names, group names, or `"all"`.
  The more specific entry wins (name over group over `"all"`); at equal
  specificity, disable wins.
- **Vault plaintext reads are stricter**: `inkbox_credentials_get_login`,
  `inkbox_credentials_get_api_key`, `inkbox_credentials_get_ssh_key`, and
  `inkbox_totp_code` must be enabled by exact name — `"vault"` or `"all"`
  never turns them on. Vault tools also need the unlock key in
  `INKBOX_VAULT_KEY` (override the variable name with the `vault.keyEnvVar`
  option).
- `inkbox_doctor` lists everything that's currently disabled, so the agent can
  tell you what to enable instead of silently lacking a capability.

## Outbound safety

Sends and calls are gated before anything leaves:

- **Approval prompts** (default): `inkbox_send_email`, `inkbox_send_sms`,
  `inkbox_send_imessage`, `inkbox_forward_email`, and `inkbox_place_call`
  request approval through opencode's native permission system. Approve once,
  or persist an allow rule from the prompt.
- **Recipient allowlist**: set `outbound.allowedRecipients` (exact email
  addresses / E.164 numbers) and anything else is rejected regardless of
  approval mode.
- **Unattended runs**: prompts time out after 5 minutes
  (`outbound.askTimeoutMs`) with a clear error instead of hanging forever. For
  headless use, either pre-allow the tools in opencode's `permission` config,
  or set `outbound.approval` to `"allowlist"` (allowlist only — requires a
  non-empty `allowedRecipients`) or `"auto"`.

```json
{
  "plugin": [["@inkbox/opencode-plugin", {
    "outbound": {
      "approval": "allowlist",
      "allowedRecipients": ["ceo@example.com", "+15551234567"]
    }
  }]]
}
```

## Skills

The package bundles skills that teach the agent Inkbox etiquette — email
triage, SMS/iMessage response patterns, outbound calling, contact and
credential hygiene, troubleshooting. Point opencode at the installed copy with
one config line:

```json
{
  "skills": { "paths": ["node_modules/@inkbox/opencode-plugin/skills"] }
}
```

(Adjust the path if your plugin cache lives elsewhere, or copy the `skills/`
directory into `.opencode/skills/` to vendor it. Skills already installed
under `.claude/skills/` are picked up by opencode's Claude Code compatibility
loading.)

## The identity model

An Inkbox identity gives the agent:

- **A mailbox** — a real email address; send, receive, reply with threading.
- **A dedicated phone number** — SMS/MMS and voice on the same line. New
  numbers take ~10–15 minutes to propagate to carriers; SMS to US numbers
  requires the recipient to opt in (text START) per carrier rules.
- **iMessage** — the agent does not get its own iMessage number. People
  connect to the agent through the shared Inkbox iMessage line, and each
  connected person gets a dedicated thread. It's recipient-first by design:
  no cold outreach; someone messages the agent first, then the agent can
  reply (and react, and even call) over that connection.

### Two calling lines

Outbound calls can originate from either line, chosen with `origination` on
`inkbox_place_call`:

- `dedicated_number` — the agent's own number, the same line SMS uses. Can
  call anyone.
- `shared_imessage_number` — call a person over the shared iMessage line they
  already message the agent on. Only works for people connected over
  iMessage; the underlying number is never surfaced.

When `origination` is omitted the plugin uses whichever line exists, and
prefers the dedicated number when both do. Note that `inkbox_place_call`
currently requires an audio bridge: pass `clientWebsocketUrl` per call or set
the `callWebsocketUrl` option (env `INKBOX_CALL_WEBSOCKET_URL`) — Inkbox
connects to that WebSocket for the call's media.

## Configuration reference

| Option | Env var | Purpose |
|---|---|---|
| `apiKey` | `INKBOX_API_KEY` | Agent-scoped API key (required) |
| `identity` | `INKBOX_IDENTITY` (also `INKBOX_AGENT_IDENTITY`, `INKBOX_AGENT_HANDLE`) | Agent handle (required) |
| `baseUrl` | `INKBOX_BASE_URL` | API base URL override |
| `signingKey` | `INKBOX_SIGNING_KEY` | Webhook signature key (future inbound use) |
| `callWebsocketUrl` | `INKBOX_CALL_WEBSOCKET_URL` | Audio-bridge WebSocket for `inkbox_place_call` |
| `vault.keyEnvVar` | — (default `INKBOX_VAULT_KEY`) | Which env var holds the vault unlock key |
| `tools.enable` / `tools.disable` | — | Tool gating (names, groups, `"all"`) |
| `outbound.approval` | — | `"ask"` (default) / `"allowlist"` / `"auto"` |
| `outbound.allowedRecipients` | — | Exact-match recipient allowlist |
| `outbound.askTimeoutMs` | — | Approval prompt timeout (default 300000) |

`apiKey`, `identity`, `baseUrl`, and `signingKey` resolve in order: plugin
option → env var → `~/.inkbox/config`.

## Inbound gateway (email/text/calls come to the agent)

Beyond outbound tools, the plugin can run an **inbound gateway**: a long-lived
process that receives email, SMS, iMessage, and phone calls to the agent's
identity and turns each into an opencode session that replies on the same
channel. It is off by default.

Two ways to run it:

- **Sidecar (recommended)** — a companion process alongside a running
  `opencode serve`:

  ```bash
  opencode serve --port 4096 &
  npx --package @inkbox/opencode-plugin inkbox-opencode run
  # or manage it as a daemon:
  inkbox-opencode start | status | stop
  ```

- **In-plugin** — set `gateway.mode` to `"plugin"` and run inside
  `opencode serve` itself. This needs the Inkbox tunnel to work under the host
  runtime (or a reachable `gateway.publicUrl`); the sidecar avoids that
  requirement.

Enable it and point sessions at a working directory:

```json
{
  "plugin": [["@inkbox/opencode-plugin", {
    "gateway": {
      "enabled": true,
      "projectDirectory": "/path/to/agent/workspace",
      "voice": { "enabled": true, "realtime": { "enabled": true } }
    }
  }]]
}
```

The gateway needs a webhook signing key (`INKBOX_SIGNING_KEY`) to verify
inbound events. What it does:

- **Email / SMS / iMessage** arrive as sessions keyed per contact (one person,
  one ongoing conversation across channels); replies go back on the channel the
  message came in on, threaded for email. Delivery failures wake the agent to
  retry or switch channels.
- **Permission prompts** raised inside a gateway session are relayed to the
  contact on their channel ("reply 1 to allow once, 2 to always allow, 3 to
  decline") and time out to a decline.
- **Control commands** (whole-message): `/clear`, `/stop`, `/status`,
  `/health`, `/resume`, `/usage`.
- **Voice** (when `gateway.voice.enabled`): the agent answers calls. With
  `voice.realtime.enabled` and an OpenAI Realtime key
  (`INKBOX_REALTIME_API_KEY`), calls run as a live raw-audio conversation with
  in-call actions; otherwise Inkbox handles speech-to-text and text-to-speech.
  `inkbox_place_call` dials out with a purpose loaded into the call.

Run `inkbox-opencode doctor` to check gateway readiness (API reachability,
identity, signing key, opencode server, tunnel/public URL).

## Development

```bash
npm install
npm run typecheck   # tsc
npm test            # vitest (unit + contract)
npm run lint        # biome
npm run build       # emits dist/
bash scripts/smoke-loader.sh   # packs the tarball and loads it through a real opencode
```

The contract tests under `tests/contract/` pin the opencode plugin API surface
this package depends on; CI runs them against `@opencode-ai/plugin@latest`
twice daily to catch upstream drift.

Inbound delivery (email/texts arriving as opencode sessions) is being
validated for a future release — see `docs/gateway-spike.md` for the current
findings.
