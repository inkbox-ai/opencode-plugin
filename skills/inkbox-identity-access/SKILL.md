---
name: inkbox-identity-access
description: Use when the user asks which Inkbox agent identities can see a contact or note, or asks to grant/revoke cross-identity note access. Contacts are organization-wide; notes remain identity-scoped.
---

# Inkbox identity access

Use this skill when explaining organization-wide contact visibility or managing per-identity note access.

## Enabling the tools

All identity-access tools are opt-in. Enable the `access` group in your .opencode/plugins/inkbox.ts wrapper, then restart opencode:

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["access"] } })
```

This enables `inkbox_list_note_access`, `inkbox_grant_note_access`, and `inkbox_revoke_note_access`. Run `inkbox_doctor` to confirm which tools are currently enabled.

## Workflow

1. If the request concerns a contact, explain that every identity in the organization can see it and that contact access cannot be granted or revoked per identity.
2. For notes, resolve the note id with `inkbox_get_note` or `inkbox_list_notes`.
3. List current access with `inkbox_list_note_access` before changing it when possible.
4. Grant or revoke note access by explicit `identityId`; notes do not support wildcard grants.
5. If the user gives an agent handle instead of an identity UUID, `inkbox_whoami` returns the current identity's own id and handle, and note access listings may already contain the other identity's id. If neither resolves the handle, explain that you need the identity id.

## Safety

Note access changes affect what other Inkbox agent identities can see. Confirm the target identity and note before changing access.
