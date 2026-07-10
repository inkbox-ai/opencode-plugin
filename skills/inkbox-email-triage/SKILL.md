---
name: inkbox-email-triage
description: Use when the user asks the agent to triage its Inkbox inbox or unread queue, or to reply to, forward, or send mail on its Inkbox identity. Does not cover the human owner's personal email.
---

# Inkbox email triage

The Inkbox plugin gives you a working mailbox under an agent identity. Use this skill whenever the user asks you to work through the inbox: check unread mail, read a thread, reply, forward, or send.

## Required tools

Enabled by default:

- `inkbox_list_unread_emails` — start here
- `inkbox_list_emails` — browse beyond the unread queue when the user asks about older mail
- `inkbox_get_email` — full body when the list summary isn't enough
- `inkbox_get_email_thread` — pull the rest of a thread before replying
- `inkbox_send_email` — send new mail or reply (always pass `inReplyToMessageId` when replying)

Opt-in — `inkbox_mark_emails_read` (clear processed messages) and `inkbox_forward_email` (forward with original parts) must be enabled by the user in opencode.json, then opencode restarted:

```json
"plugin": [["@inkbox/opencode-plugin", { "tools": { "enable": ["inkbox_mark_emails_read", "inkbox_forward_email"] } }]]
```

(Enabling the `"email"` group turns both on at once.) `inkbox_doctor` reports which tools are currently enabled or disabled.

## Workflow

1. **Pull the queue.** Call `inkbox_list_unread_emails` with `limit` matching how much you intend to process this turn (default 25 is reasonable). Each result has `id`, `threadId`, `subject`, `fromAddress`, and a body preview.

2. **Decide per message.** For each unread email:
   - **Trivial reply** → call `inkbox_send_email` with `inReplyToMessageId` set to the original message's `messageId` (the RFC 5322 Message-ID field — not the UUID `id`). The recipient's client will thread it.
   - **Needs context** → call `inkbox_get_email_thread` with the message's `threadId` to read the full conversation before composing.
   - **Forward to someone** → call `inkbox_forward_email` (opt-in — see above). Prefer `mode: "inline"` to re-attach original parts.
   - **No action** → skip; don't mark as read unless you actually processed it.

   Sends prompt for approval through opencode's permission system by default, so batch your decisions rather than firing sends one at a time.

3. **Clear the queue.** Once a batch is handled, call `inkbox_mark_emails_read` with the ids you processed. If the tool isn't enabled, leave them unread and tell the user which ids were handled.

## Reply hygiene

- Always thread replies. The `inReplyToMessageId` parameter on `inkbox_send_email` takes the original message's `messageId` (the RFC 5322 Message-ID returned by `inkbox_list_unread_emails` / `inkbox_get_email`) and threads correctly in the recipient's client.
- Keep the same subject (or prefix with `Re:` once, not stacked).
- If you're replying to a thread, glance at the most recent ~2 messages from `inkbox_get_email_thread` so you don't repeat what's already been said.

## Errors you may see

- 403 with `recipient_not_opted_in` — only applies to SMS, not email. If you see this on email, surface it as-is.
- 404 — message id is wrong or the message has been deleted; skip and move on.

## When you need more — raw Inkbox docs

If something here doesn't match what you're seeing, or you need API behavior this skill doesn't describe (field names, error codes, edge cases), go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Prefer fetching these over guessing.
