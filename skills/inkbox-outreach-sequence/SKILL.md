---
name: inkbox-outreach-sequence
description: Use when the user asks the agent to follow up with someone over multiple days, run a multi-step outreach campaign across email and SMS, or "ping them again in 2 days if they don't respond". Coordinates send tools with reply checks between steps.
---

# Inkbox outreach sequence

Use this skill whenever the user asks for **multi-step outbound communication** — typically over several days, often combining email + SMS, with branching on whether the recipient replied.

## Required tools (default-enabled)

- `inkbox_send_email` — primary outbound for longer-form steps
- `inkbox_send_sms` — short nudges; respects opt-in/opt-out
- `inkbox_list_text_conversations` / `inkbox_get_text_conversation` — check whether the recipient has replied to past SMS
- `inkbox_list_unread_emails` — check whether the recipient has replied to past email
- `inkbox_lookup_contact` — resolve names to addresses before the first step
- `inkbox_create_note` / `inkbox_list_notes` — record the outreach plan + state so later sessions can pick it up

## Optional (must be enabled in config)

- `inkbox_forward_email` — escalate to a third party if no reply. Disabled by default; the user enables it in opencode.json and restarts opencode:

```json
"plugin": [["@inkbox/opencode-plugin", { "tools": { "enable": ["inkbox_forward_email"] } }]]
```

If unsure what is currently enabled, run `inkbox_doctor`.

## Workflow

A sequence is a small state machine: a fixed list of steps, each with a channel and a delay from the prior step. opencode does not run steps on a timer — the user (or their own cron/scheduler) re-invokes the agent when a step is due. Each time you are asked to continue a sequence: check for a reply first; if one arrived, exit early.

### 1. Plan before doing

Ask the user enough to fill in:
- **Who** is the recipient (name → resolve via `inkbox_lookup_contact`)
- **Steps:** ordered list, each with channel (email/SMS), copy, and delay from previous step
- **Exit condition:** typically "any reply"; sometimes "specific keyword in reply"

If the user is vague, propose a default 3-step sequence: email today → SMS in 2 days → email in 5 days.

### 2. Run the due step

1. **Check for reply since last step.**
   - If last step was email: `inkbox_list_unread_emails` and look for messages from the recipient's address.
   - If last step was SMS: `inkbox_get_text_conversation(remotePhoneNumber)` and look for new inbound messages.
   - Reply found → exit the sequence and log a note with `inkbox_create_note`.
2. **Send the step.** Email → `inkbox_send_email` (thread to last outbound if possible via `inReplyToMessageId`). SMS → `inkbox_send_sms`. Each send prompts for approval through opencode's permission system by default; for a long sequence the user can add the recipient to the plugin's `outbound.allowedRecipients` and use approval mode `"allowlist"` so every step isn't re-approved by hand.
3. **Report the next due time.** Tell the user when step N+1 should run — the agent does not wait or schedule the delay itself.

### 3. Record state

Persist the sequence with `inkbox_create_note`, body like:

```
Outreach to Ada Lovelace (contact UUID xxx):
- Step 1 sent 2026-05-21 (email, id=...)
- Step 2 due 2026-05-23 (SMS)
- Step 3 due 2026-05-26 (email)
- Exit: any reply
```

Future sessions `inkbox_list_notes` to recover the plan — this is what lets a sequence survive across invocations. Update the note after every step.

## Hygiene

- **Don't ignore opt-out.** If `inkbox_send_sms` returns "Recipient has opted out", the entire sequence stops for that contact — do not switch them to email-only without the user's explicit OK.
- **Respect quiet hours.** SMS in particular shouldn't fire at 3am local. If the user hasn't specified timing, default to business hours in the recipient's time zone (or US Eastern if unknown).
- **Cap the depth.** More than ~5 outbound touches without a reply is harassment. Surface this concern to the user before queueing step 6+.
- **Thread email.** Always pass `inReplyToMessageId` on follow-up emails so the recipient sees one conversation, not five separate cold pitches.

## What this skill does NOT cover

- Bulk outreach to many contacts at once (current plugin scope is one recipient at a time per sequence).
- A/B testing different copy.
- Inbound parsing (intent detection on the reply body) — the agent reads the reply and decides, no auto-classifier.

## When you need more — raw Inkbox docs

If a delivery-status field, reply-detection edge case, or rate-cap detail isn't covered here, go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.
