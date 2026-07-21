---
name: inkbox-contact-rules
description: Use when the user asks who can reach the agent's Inkbox mailbox, phone number, or shared iMessage line — viewing email/SMS/call/iMessage allow and block rules, checking why a sender was filtered, or handling a request to block or allow someone.
---

# Inkbox contact rules

Use this skill when the user asks about who can reach the agent's Inkbox
mailbox, phone number, or shared iMessage line.

## Tools (read-only, enabled by default)

- `inkbox_list_mail_contact_rules` — email allow/block rules
- `inkbox_list_phone_contact_rules` — SMS + voice allow/block rules
- `inkbox_list_imessage_contact_rules` — shared iMessage line allow/block rules

The API is read-only for agents by design: an agent-scoped key can VIEW its
contact rules but never create, change, or delete them. Rule changes are made
by a human in the Inkbox console (https://inkbox.ai/console/contact-rules).

## Workflow

1. When the user asks "who is blocked?", "can X reach you?", or "why didn't
   my email arrive?" — list the rules for the matching channel and read the
   result: `action: "block"` rejects matching traffic and `action: "allow"`
   permits it when a whitelist posture is active.
2. Match types: mail rules use `exact_email` or `domain`; phone and iMessage
   rules use `exact_number` (E.164, e.g. `+15551234567`). Phone rules apply
   to both SMS and voice on the dedicated number.
3. When the user asks you to block or allow someone, list the current rules
   first, then direct them to the Inkbox console to make the change — you
   cannot change rules yourself. Offer the exact rule they should create
   (channel, matchType, matchTarget, action).
4. Explain that blocked senders and callers are rejected upstream: their
   mail, texts, and calls will not appear when the user later asks you to
   check the inbox, message history, or call log.
