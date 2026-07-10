---
name: inkbox-contact-rules
description: Use when the user wants to block, allow, pause, delete, or list Inkbox contact-rule filters for the agent's mailbox or phone number, including email allow/block rules, SMS/call allow/block rules, allowlists, blocklists, spam blocking, or "only accept from" requests.
---

# Inkbox contact rules

Use this skill when managing who can reach the agent's Inkbox mailbox or phone number.

## Tools (all opt-in)

- `inkbox_list_mail_contact_rules`
- `inkbox_create_mail_contact_rule`
- `inkbox_update_mail_contact_rule`
- `inkbox_delete_mail_contact_rule`
- `inkbox_list_phone_contact_rules`
- `inkbox_create_phone_contact_rule`
- `inkbox_update_phone_contact_rule`
- `inkbox_delete_phone_contact_rule`

None are enabled by default. The user must enable them in your .opencode/plugins/inkbox.ts wrapper — the `contact-rules` group covers all eight (exact tool names also work) — then restart opencode:

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["contact-rules"] } })
```

If a rule tool is missing, run `inkbox_doctor` to see the enabled/disabled tool list, then tell the user what to add.

## Workflow

1. List existing rules before making changes when the user is ambiguous.
2. For mailbox rules:
   - `matchType: "exact_email"` for one sender address.
   - `matchType: "domain"` for a whole sender domain.
   - `action: "block"` to reject matching mail.
   - `action: "allow"` to permit matching mail when whitelist mode is active.
3. For phone rules:
   - `matchType: "exact_number"` for E.164 numbers (e.g. `+15551234567`).
   - Rules apply to both SMS and voice calls for that phone number.
4. Use `status: "paused"` to temporarily disable a rule without deleting it.
5. Explain that blocked senders and callers are rejected upstream: their mail, texts, and calls will not appear when the user later asks you to check the inbox, message history, or call log.

## Safety

Do not switch a channel into whitelist-only behavior unless a tool explicitly supports filter-mode changes and the user clearly requests that behavior. Whitelist mode blocks everyone who is not explicitly allowed.
