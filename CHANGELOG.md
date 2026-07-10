# Changelog

## 0.1.0 (unreleased)

Initial release.

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
