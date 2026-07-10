---
name: inkbox-imessage-responder
description: Use when the user asks to send an iMessage, reply to or triage the agent's iMessage conversations, or explain how to reach the agent over iMessage. Covers the connect/router model, the recipient-first rule, and tapback reactions.
---

# Inkbox iMessage responder

The Inkbox plugin makes this agent reachable over iMessage. Unlike SMS, the agent does not own an iMessage number: people connect through the Inkbox iMessage router, and each connected person gets a dedicated conversation with this agent. Use this skill whenever the user asks you to check, triage, or reply to iMessage conversations — short, conversational, reply-driven.

## How the channel works

- A person texts the connect command (e.g. `connect @agent-handle`) to the Inkbox iMessage router number from their iPhone. Get both with `inkbox_imessage_triage_number`.
- Inkbox texts them back from the number assigned to their conversation with this agent. All chat happens in that thread.
- **Recipient-first:** the agent cannot message anyone over iMessage until that person has messaged it first. There is no cold outreach on this channel. If an outbound send returns a 409-style error saying the recipient hasn't messaged yet or is no longer connected, tell the user the person needs to (re)connect and send a message first.
- If someone asks "how do I iMessage you?", answer with the router number and connect command from `inkbox_imessage_triage_number`.

## Tools

Enabled by default:

- `inkbox_list_imessage_conversations` — start here for triage; returns conversation IDs, latest-message previews, unread counts, and assignment status
- `inkbox_get_imessage_conversation` — pull message history (includes tapback reactions on each message)
- `inkbox_send_imessage` — outbound by `conversationId` (preferred) or `to` E.164

Opt-in — the user must enable these in your .opencode/plugins/inkbox.ts wrapper, then restart opencode:

- `inkbox_imessage_triage_number` — router number + connect command for onboarding new people
- `inkbox_list_imessage_assignments` — who is actively connected to this agent right now (one row per recipient)
- `inkbox_send_imessage_reaction` — tapback (love/like/dislike/laugh/emphasize/question) on a received message
- `inkbox_mark_imessage_conversation_read` — send a read receipt and clear unread state

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["inkbox_send_imessage_reaction", "inkbox_mark_imessage_conversation_read"] } })
```

(Enabling the `"imessage"` group turns all four on at once.) `inkbox_doctor` reports which tools are currently enabled or disabled.

## Workflow

1. **Pull conversations.** Call `inkbox_list_imessage_conversations` (defaults: `limit: 25`). Each row includes the conversation ID, remote number, latest text, unread count, total count, and assignment status. `released` means that person disconnected, so a reply will fail until they reconnect through the router; tell them how instead of retrying.

2. **Pick a conversation to handle.** If you need history, call `inkbox_get_imessage_conversation` with `conversationId: row.id`. Inbound messages may carry `reactions` — tapbacks the person put on a message.

3. **Compose and send.** Reply with `inkbox_send_imessage` using `conversationId`. Keep the tone conversational — iMessage is a chat thread, not email. A `sendStyle` (confetti, balloons, …) is available for celebratory moments; use sparingly. Sends prompt for approval through opencode's permission system by default.

4. **React when a reply would be noise.** A tapback via `inkbox_send_imessage_reaction` (e.g. `like` on an acknowledgment) often beats a filler message.

5. **Mark as handled** if `inkbox_mark_imessage_conversation_read` is enabled: pass `conversationId` — this also shows the sender a read receipt.

## Reading tapbacks on your messages

Conversation history also shows tapbacks people put on **your** messages. A reaction is a lightweight signal, not always a request for a reply:

- A `question` tapback usually asks for clarification or a follow-up — replying is normally warranted.
- `emphasize` may invite a brief acknowledgement or follow-up.
- `love` / `like` / `laugh` / `dislike` are usually just acknowledgements that need no response.

Reply (via `inkbox_send_imessage`) only when a response genuinely adds value; otherwise leave the reaction unanswered.

## Calling someone on the shared iMessage line

If a person you're connected to over iMessage should get a call, place it over the **shared iMessage line** — the same line you're already messaging them on — with `inkbox_place_call` and `origination: "shared_imessage_number"`. Do **not** call an iMessage contact from your dedicated phone number; they reach you on iMessage, and shared-line calling only works while they stay connected. If the call is refused because they aren't connected, ask them to reconnect over iMessage first (or, only if you have their number for that purpose, call from your dedicated line instead).

`inkbox_place_call` is opt-in (enable it — or the `"calls"` group — the same way as above). It takes `toNumber`, `origination`, and optionally `clientWebsocketUrl`; every call needs a call WebSocket (an audio bridge Inkbox connects to), supplied per call via `clientWebsocketUrl` or via the `callWebsocketUrl` plugin option / `INKBOX_CALL_WEBSOCKET_URL`.

## When you need more — raw Inkbox docs

If channel behavior or a field name doesn't match what you're seeing:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Prefer fetching these over guessing.
