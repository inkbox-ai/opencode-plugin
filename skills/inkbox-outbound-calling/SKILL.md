---
name: inkbox-outbound-calling
description: Use when the user asks the agent to place an outbound Inkbox phone call, call a phone number, or call a contact by voice.
---

# Inkbox outbound calling

Use this skill when the user asks you to call someone.

## Required tool (opt-in)

- `inkbox_place_call` — place an outbound voice call.

It is disabled by default. The user must enable it in your .opencode/plugins/inkbox.ts wrapper (by exact name, or via the `"calls"` group) and restart opencode:

```ts
// in your .opencode/plugins/inkbox.ts wrapper:
InkboxPlugin(input, { "tools": { "enable": ["inkbox_place_call"] } })
```

`inkbox_doctor` reports whether it is currently enabled.

## Two calling paths

A call can go out over one of two lines:

- **Your dedicated number** (`origination: "dedicated_number"`) — the identity's own phone number, the same line SMS and voice conversations use. Use this to call anyone reachable by phone; it is the default choice.
- **The shared Inkbox iMessage line** (`origination: "shared_imessage_number"`) — call someone over the shared iMessage line they already message you on. This only works if that person is connected to your identity over iMessage; if they aren't, the call is rejected and you should fall back to your dedicated number or ask them to message you on iMessage first. You never see or choose the underlying shared number — Inkbox resolves it from the connection.

## Call audio bridge

Every call needs a WebSocket audio bridge (`wss://...`) that Inkbox connects to for the call's audio stream. It comes from either:

- the `clientWebsocketUrl` argument on the call, or
- the `callWebsocketUrl` plugin option / `INKBOX_CALL_WEBSOCKET_URL` env var.

If neither is set, the tool errors. Ask the user for a bridge URL — never invent one.

## Workflow

1. Resolve the recipient to an E.164 phone number. If the user names a contact, use `inkbox_lookup_contact` first.
2. Decide the line: dedicated number for anyone reachable by phone or anyone new; shared iMessage line only for someone already connected over iMessage.
3. Call `inkbox_place_call` with `toNumber`, `origination`, and `clientWebsocketUrl` (omit the URL if the bridge is configured in the plugin options). Placing a call prompts for approval through opencode's permission system by default.
4. The result includes the queued call's `id`, `status`, `origination`, and remaining outbound-call rate limit — surface these to the user before queueing more calls.

## Follow-ups

If the user wants a post-call email/SMS/note, wait for the call to finish, review it with `inkbox_list_calls` and `inkbox_list_call_transcripts` (both enabled by default), then send the follow-up with the matching Inkbox send tool.
