---
name: inkbox-notes-memory
description: Use when the user asks to save, remember, list, retrieve, update, or delete notes in Inkbox. This is for persistent Inkbox notes, not workspace-local memory.
---

# Inkbox notes memory

The Inkbox plugin exposes persistent notes scoped by the configured Inkbox identity. Use these tools when a user asks to save a note, remember free-form context in Inkbox, or retrieve prior Inkbox notes.

## Default-enabled tools

- `inkbox_list_notes` — list/search notes visible to this identity
- `inkbox_get_note` — fetch a full note by UUID
- `inkbox_create_note` — create a persistent Inkbox note

## Opt-in tools

- `inkbox_update_note` — update an existing note by UUID
- `inkbox_delete_note` — delete a note by UUID

These are disabled by default. The user must enable them in your .opencode/plugins/inkbox.ts wrapper (by exact tool name, or the `notes` group) and restart opencode:

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["inkbox_update_note", "inkbox_delete_note"] } })
```

`inkbox_doctor` reports which tools are currently enabled or disabled.

## Workflow

1. **Use Inkbox notes for free-form memory.** When the user says "save a note", "remember this in Inkbox", or asks for durable non-contact context, call `inkbox_create_note`.

2. **Do not store contact details as notes.** If the user asks to save a person, phone number, email, address-book entry, or "my contact", use the contact workflow: lookup first, then create or update an Inkbox contact.

   Contact `notes`, generated contact facts, and Inkbox notes are distinct. Generated facts are source-grounded organization-wide memory and must not be copied into either user-managed notes surface.

3. **Search before editing.** For "update the note about X", call `inkbox_list_notes` with a focused query, then `inkbox_get_note` if needed before using `inkbox_update_note`.

4. **Be explicit about opt-in tools.** If update/delete is not enabled, say that the note was found but the tool is disabled, and point the user at the config snippet above.

## Access semantics

- Note reads are filtered server-side by the Inkbox identity's access grants.
- Notes are persistent Inkbox records. They are different from workspace-local notes/memory and should be used whenever the user specifically refers to Inkbox notes.

## When you need more - raw Inkbox docs

If a notes field, access rule, or error behavior is not covered here, use the raw docs:

- **https://inkbox.ai/llms.txt** - LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** - the full Inkbox documentation concatenated as one markdown file.
