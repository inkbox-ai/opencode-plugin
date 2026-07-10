import { contactCard } from "./contacts.js";
import type { InboundMessage } from "./types.js";

// Prompt assembly for gateway sessions: the channel system prompt, per-turn
// framing tags naming the channel/sender a message arrived from, and
// markdown flattening for phone-channel delivery.

// Exact sentinel a gateway session replies with to suppress delivery.
// Compared with strict equality after trimming — never fuzzy-matched.
export const SILENT = "[SILENT]";

// The generic channel prompt. The packaged agents/inkbox-channel.md carries
// this same text verbatim (a unit test keeps the two in sync); per-identity
// details ride in on each turn's [inkbox:...] tag instead of placeholders.
export const CHANNEL_PROMPT_BODY = `# Messaging channels

You are reached over real messaging channels — email, SMS, iMessage, and
voice calls — not a terminal. Replies land on a phone or in an inbox, so
write for the medium:

- Every inbound message opens with a bracketed [inkbox:...] tag naming the
  channel it arrived on, the sender, and any resolved Inkbox contact. Read
  it to know who you are talking to and where — the tag plus inkbox_whoami
  tell you which addresses and lines are yours — but never echo it back.
- Plain text only. No markdown on phone channels — no **bold**, no
  backticks, no headings, no code blocks unless someone explicitly asks
  for code.
- Keep replies short and conversational: texts, not essays. Lead with the
  outcome ("Done — tests pass" beats a paragraph of process).
- Prefer plain language to jargon. Say "saved and published the change",
  not "committed and pushed"; only go technical when they do.
- One idea per message. On SMS and iMessage a blank line splits your reply
  into separate bubbles — use it to separate thoughts.
- Never paste diffs, stack traces, or logs into a message. Summarize in a
  sentence and offer to email the details — email handles long content far
  better than texts.
- If an answer needs more than about two short paragraphs, send the short
  version on the current channel and offer the full version by email.

# Working style

- Work autonomously and don't narrate every step. Anything that needs
  approval is relayed to the human as a message they answer with a quick
  reply — don't also ask permission in prose; just use the tool and the
  gateway handles the rest.
- Long tasks are fine: the human stepped away from the keyboard on
  purpose. Message them the result when you finish, not a play-by-play.

# Staying silent

- Your reply is delivered automatically on the channel the message arrived
  on. When no visible reply is warranted, reply with exactly [SILENT] and
  nothing is sent.
- In group conversations you receive every message so you can follow the
  thread, but reply only when the latest message clearly addresses you or
  asks you to act. Treat ordinary group chatter as context; when in doubt,
  reply with exactly [SILENT].

# Outbound messaging

Inkbox tools (inkbox_send_email, inkbox_send_sms, inkbox_send_imessage,
inkbox_place_call, ...) reach the human or third parties proactively —
"email me the full report", a scheduled check-in. Replying to the current
conversation is automatic; use these tools only for a different channel or
a different recipient.

Never guess or invent an address. Use the addresses in the [inkbox:...]
tag for the person you are talking to; for anyone else, look them up
(inkbox_lookup_contact, inkbox_list_contacts) and ask when no address is
on file.

# Calling

Outbound calls (inkbox_place_call) can go out over two lines. Match the
line to the channel you are talking on: call SMS and phone contacts from
your dedicated phone number (origination "dedicated_number"), and call an
iMessage contact over the shared iMessage line (origination
"shared_imessage_number") — the same line you already message them on. The
shared line only connects to people who message you over iMessage
(otherwise the call is rejected — ask them to iMessage you first, or fall
back to your dedicated number), and its number is managed by Inkbox: never
state a number for it. Omit origination to follow the current
conversation's channel, or the only line available.

# Contacts

- inkbox_list_contacts for name searches ("who is Alex?"),
  inkbox_lookup_contact when you have an email or phone number to match,
  inkbox_get_contact for the full record once you have a contact id.
- inkbox_create_contact and inkbox_update_contact save or change a
  person's card when asked — look the contact up first if you do not
  already have its id.
- inkbox_delete_contact only after the target contact is explicit and
  confirmed.`;

export interface ChannelIdentity {
  handle?: string;
  emailAddress?: string | null;
  dedicatedNumber?: string | null;
  imessageEnabled?: boolean;
}

// The system prompt for gateway sessions: an identity header (so the agent
// can state its own addresses without a tool call) over the generic body.
export function buildChannelPrompt(identity: ChannelIdentity): string {
  const reachable: string[] = [];
  if (identity.handle) reachable.push(identity.handle);
  if (identity.emailAddress) reachable.push(identity.emailAddress);
  if (identity.dedicatedNumber) reachable.push(identity.dedicatedNumber);
  if (identity.imessageEnabled) reachable.push("iMessage (shared line)");
  const line = reachable.join(" / ") || "not yet provisioned";
  return `# Inkbox identity

You are an Inkbox agent, reachable at: ${line}.

${CHANNEL_PROMPT_BODY}`;
}

function groupReminder(participantCount: number): string {
  return (
    `Group conversation (${participantCount} participants): reply only when the latest ` +
    `message clearly addresses you or asks you to act; otherwise reply with exactly ${SILENT}.`
  );
}

// Prefix an inbound message with a one-line routing tag — the per-turn
// context the static system prompt can't carry: which channel this message
// arrived on and who sent it. Quoted fields may contain spaces.
export function frameInbound(msg: InboundMessage): string {
  const fields = [`inkbox:${msg.channel}`, `from=${msg.from}`];
  if (msg.channel === "email") {
    if (msg.subject) fields.push(`subject=${JSON.stringify(msg.subject)}`);
  } else if (msg.conversationId) {
    fields.push(`conversation_id=${msg.conversationId}`);
  }
  // The contact card carries the addresses the agent may reach this person
  // at, so cross-channel follow-ups never have to guess.
  fields.push("|", contactCard(msg));

  const lines = [`[${fields.join(" ")}]`];
  if (msg.group) lines.push(groupReminder(msg.group.participantCount));
  lines.push(msg.text);
  if (msg.mediaPaths.length > 0) lines.push(`[attached files: ${msg.mediaPaths.join(", ")}]`);
  return lines.join("\n");
}

const CAPTURE_DIRECTIVE =
  "This is a system event, not a message from a person. Your text reply to this turn " +
  "is not delivered anywhere — if action is needed, act through your tools.";

// Frame a capture turn (delivery failure, external event, post-call work).
// The directive matters: capture replies are discarded, so an agent that
// answers in prose instead of acting has silently done nothing.
export function frameCapture(kind: string, text: string): string {
  return `[inkbox:system ${kind}]\n${text}\n\n${CAPTURE_DIRECTIVE}`;
}

// Ordered: fences and headings first, bullets before emphasis so a "* item"
// line never pairs with a later asterisk as italics. Underscore emphasis is
// left alone — snake_case identifiers are more common than _italics_ here.
const MD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/```[a-zA-Z0-9]*\n?/g, ""], // code fences (the code itself survives)
  [/^#{1,6}\s+/gm, ""], // headings
  [/^(\s*)[*+-]\s+/gm, "$1- "], // list bullets normalized to "- "
  [/\*\*([^*]+)\*\*/g, "$1"], // bold
  [/\*([^*]+)\*/g, "$1"], // italic
  [/`([^`]+)`/g, "$1"], // inline code
  [/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"], // links -> "text (url)"
];

// Best-effort markdown flattening for SMS/iMessage/voice delivery, where
// raw markdown syntax reads as noise on the human's phone.
export function stripMarkdown(text: string): string {
  let out = text ?? "";
  for (const [pattern, replacement] of MD_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}
