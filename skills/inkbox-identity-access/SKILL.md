---
name: inkbox-identity-access
description: Use when the user asks which Inkbox agent identities can see a contact or note, or asks to grant/revoke cross-identity access to contacts or notes.
---

# Inkbox identity access

Use this skill when managing per-identity visibility for Inkbox contacts and notes.

## Enabling the tools

All identity-access tools are opt-in. Enable the `access` group in your .opencode/plugins/inkbox.ts wrapper, then restart opencode:

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["access"] } })
```

This enables `inkbox_list_contact_access`, `inkbox_grant_contact_access`, `inkbox_revoke_contact_access`, `inkbox_list_note_access`, `inkbox_grant_note_access`, and `inkbox_revoke_note_access`. Run `inkbox_doctor` to confirm which tools are currently enabled.

## Workflow

1. Resolve the contact or note id first. If the user names a person or note, use `inkbox_lookup_contact`, `inkbox_list_contacts`, `inkbox_get_note`, or `inkbox_list_notes`.
2. List current access with `inkbox_list_contact_access` / `inkbox_list_note_access` before changing it when possible.
3. For contacts:
   - Grant a specific identity with `identityId`.
   - Use `wildcard: true` only when the user wants every active identity to see the contact; it replaces the specific grants. Pass either `identityId` or `wildcard`, never both.
   - Revoke by `identityId`.
4. For notes:
   - Grant and revoke only by explicit `identityId`; notes do not support wildcard grants.
5. If the user gives an agent handle instead of an identity UUID: `inkbox_whoami` returns the current identity's own id and handle, and access listings may already contain the other identity's id. If neither resolves the handle, explain that you need the identity id.

## Safety

Access changes affect what other Inkbox agent identities can see. Confirm the target identity and object before granting broad or wildcard contact access.
