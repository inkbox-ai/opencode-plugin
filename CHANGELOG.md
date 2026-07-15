# Changelog

## 0.1.0 (unreleased)

Initial release.

- Requires `@inkbox/sdk` 0.5.0 or newer.
- 56 `inkbox_*` tools across email, SMS/MMS, iMessage, calls, contacts, notes,
  contact rules, access grants, encrypted vault, and diagnostics. 24 are
  enabled by default; the rest are opt-in via the `tools.enable` plugin option
  (`inkbox_doctor` reports what is off and how to enable it).
- Outbound sends and calls gate through opencode's native permission prompts,
  with a recipient allowlist and configurable approval modes for unattended
  runs.
- Credentials resolve from plugin options, `INKBOX_*` environment variables,
  or `~/.inkbox/config`.
- 12 bundled skills covering email triage, SMS/iMessage response etiquette,
  outbound calling, contact management, notes, credential use, and
  troubleshooting.
- Optional inbound gateway (off by default): receives email, SMS, iMessage,
  and calls to the agent's identity and turns each into an opencode session
  that replies on the same channel. Contact-keyed sessions, signature
  verification and dedup, per-contact permission relaying, control commands,
  inbound/outbound media, delivery-failure recovery, and external webhook
  providers. Voice answers calls via Inkbox speech or an OpenAI Realtime
  raw-audio bridge with in-call actions. Runs as a sidecar
  (`inkbox-opencode`) or inside `opencode serve`.
- Local-file media on `inkbox_send_email` (`attachmentPaths`),
  `inkbox_send_sms`/`inkbox_send_imessage` (`mediaPaths`); `inkbox_place_call`
  carries a call purpose and opening message.
