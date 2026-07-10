---
name: inkbox-contact-lookup
description: Use when the user asks "who is X", "what's the email for Y", "find a contact named Z", "save this contact", or any request that needs contact context. The agent can read and write Inkbox contacts visible to the configured identity; contact access grants, contact rules, and vCard flows are separate surfaces.
---

# Inkbox contact lookup

Inkbox contacts are an address-book scoped to the configured identity. When the user asks about a person, wants to save or edit a contact, or needs an address or number resolved, use the contact tools below.

## Required tools

All six are enabled by default:

- `inkbox_list_contacts` — name-based searches like "who is Alex?"
- `inkbox_lookup_contact` — exact or partial email/phone filters
- `inkbox_get_contact` — fetch a full contact by UUID after list/lookup returns one
- `inkbox_create_contact` — save a new person or contact card
- `inkbox_update_contact` — change an existing contact after you know its UUID
- `inkbox_delete_contact` — delete a contact only after the target is explicit and confirmed

There is no vCard export/import tool. Contact access tools, contact rule tools, and `inkbox_place_call` are opt-in — the user must enable them in opencode.json and restart opencode:

```json
"plugin": [["@inkbox/opencode-plugin", { "tools": { "enable": ["inkbox_place_call", "access", "contact-rules"] } }]]
```

Use access and rule tools only when the user explicitly asks to manage sharing or allow/block rules. `inkbox_doctor` reports which tools are enabled or disabled.

## Workflow

1. **Look up named people.** If the user asks about a named person, call `inkbox_list_contacts` with the name before saying you do not know.
2. **Use literal addresses when supplied.** If the user gives an email address or phone number, use it directly with `inkbox_send_email`, `inkbox_send_sms`, `inkbox_send_imessage`, or (if enabled) `inkbox_place_call`; optionally call `inkbox_lookup_contact` if the user asks who it belongs to.
3. **Create contacts when asked.** If the user asks you to save someone new and provides at least one useful field, call `inkbox_create_contact`.
4. **Update contacts by UUID.** If the user asks you to edit a contact, resolve the contact with list/lookup/get first, then call `inkbox_update_contact` with only the fields that should change. Omitted fields remain unchanged.
5. **Delete cautiously.** If the user asks to delete a contact, confirm the exact target when there is any ambiguity, then call `inkbox_delete_contact` with the UUID.
6. **Ask when the target is ambiguous.** If lookup returns multiple plausible contacts, ask which contact the user means before sending, calling, updating, or deleting.

## Access semantics

- Contact tools operate only on contacts visible/writable to the configured identity.
- Contacts created through `inkbox_create_contact` are Inkbox address-book records, not local notes or session memory.
- Sharing contacts across Inkbox identities is grant management — that requires the opt-in access tools, and only when the user explicitly asks for it.

## What this skill does NOT cover

- vCard export/import — not exposed as an agent tool.
- Arbitrary persistent memory. Use Inkbox notes for persistent notes and Inkbox contacts for address-book facts.

## When you need more — raw Inkbox docs

If a lookup filter, contact field, or access semantics question isn't covered here, go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Prefer fetching these over guessing field names or filter semantics.
