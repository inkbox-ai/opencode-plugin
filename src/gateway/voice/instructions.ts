import type { ResolvedContact } from "../contacts.js";
import {
  CONSULT_TOOL,
  DELETE_ACTION_TOOL,
  EDIT_ACTION_TOOL,
  HANG_UP_TOOL,
  REGISTER_ACTION_TOOL,
} from "./realtime.js";

// Everything the voice model needs to know about this specific call: who is
// on the line, which identity it is speaking as, and why the call exists.
export interface CallMeta {
  callId?: string;
  direction: "inbound" | "outbound";
  from?: string;
  contact: ResolvedContact;
  identity: {
    handle?: string;
    emailAddress?: string | null;
    dedicatedNumber?: string | null;
    imessageEnabled?: boolean;
  };
  purpose?: string;
  openingMessage?: string;
  context?: string;
}

// Spoken-friendly summary of what the text-based agent can do through the
// consult tool, so the voice model neither undersells nor overpromises.
const AGENT_CAPABILITIES = [
  "send email, SMS, and iMessage",
  "read and manage past email and text conversations",
  "look up, list, create, update, or delete contacts",
  "place outbound phone calls",
  "take, read, and organize notes",
  "store and retrieve secrets from the encrypted vault",
  "run coding and terminal work in the project it is attached to",
];

// Compose the system prompt for a live voice call. Identity, caller context,
// tool choreography, and privacy rules — mirrored across call modes.
export function buildVoiceInstructions(meta: CallMeta): string {
  const lines: string[] = [
    "You are an assistant speaking on a live phone call.",
    "Use natural, concise spoken replies. Keep most answers to one or two short sentences.",
    "Do not mention implementation details unless the caller asks.",
  ];

  const id = meta.identity;
  if (id.handle) lines.push(`Your Inkbox identity handle: ${id.handle}.`);
  if (id.emailAddress) lines.push(`Your email address: ${id.emailAddress}.`);
  if (id.dedicatedNumber) {
    lines.push(
      `Your dedicated phone line (your own number, for SMS and voice calls): ${id.dedicatedNumber}.`,
    );
  }
  if (id.imessageEnabled) {
    lines.push(
      "You also have a shared Inkbox iMessage line — voice calls and iMessage " +
        "with people connected to you over iMessage. Its number is managed by " +
        "Inkbox: never state or promise a number for it.",
    );
  }

  if (meta.from && meta.from !== "unknown") {
    lines.push(`The other party's number on this call: ${meta.from}.`);
  }
  const c = meta.contact;
  if (c.contactId && c.contactName) {
    lines.push(
      "You already know who this is — do NOT look them up or ask for details you already have below.",
      `Their name: ${c.contactName}.`,
    );
    if (c.contactEmails?.length) lines.push(`Their email(s): ${c.contactEmails.join(", ")}.`);
    if (c.contactPhones?.length)
      lines.push(`Their phone number(s) on file: ${c.contactPhones.join(", ")}.`);
    if (c.contactCompany) lines.push(`Their company: ${c.contactCompany}.`);
    if (c.contactNotes) lines.push(`Notes about them: ${c.contactNotes}`);
  } else {
    lines.push(
      "No matching contact record is loaded — you do NOT know who this is. " +
        `Greet them neutrally; you may ask ${CONSULT_TOOL} to look them up by number if needed.`,
    );
  }

  if (meta.direction === "outbound") {
    if (meta.purpose) {
      lines.push(`This is an outbound call you placed. Purpose: ${meta.purpose}`);
    }
    if (meta.openingMessage) {
      lines.push(
        `Preferred opening message (say this naturally as your first turn): ${meta.openingMessage}`,
      );
    }
    lines.push(
      "For outbound calls, do not open with a generic offer to help. " +
        "Start by explaining why you are calling, then ask the next specific question.",
    );
  }
  if (meta.context) lines.push(`Background for this call: ${meta.context}`);

  lines.push(
    "Do not perform a context lookup before greeting the caller. Do not say you " +
      "are waiting on a lookup or checking context.",
    `If the caller asks for work to happen now during the live call, call ${CONSULT_TOOL}. ` +
      `The text-based agent can: ${AGENT_CAPABILITIES.join("; ")}.`,
    `Do not promise work outside that list. If you are not sure something is possible, ` +
      `call ${CONSULT_TOOL} and ask instead of guessing.`,
    "Never recite contact details or message history involving third parties to a " +
      "caller you have not recognized; offer a follow-up after the call instead.",
    `If the caller explicitly asks for work to happen after the call, or accepts an ` +
      `after-call deferral, call ${REGISTER_ACTION_TOOL}. Tell the caller the action is ` +
      `queued for after the call; do not claim it has already been completed.`,
    `If the caller changes or cancels previously queued after-call work, call ` +
      `${EDIT_ACTION_TOOL} or ${DELETE_ACTION_TOOL} with the id returned when it was queued.`,
    `If ${CONSULT_TOOL} completes or queues work that matches a previously registered ` +
      `after-call action, call ${DELETE_ACTION_TOOL} for that action so it does not run twice.`,
    `If the caller asks to hang up, says goodbye, or the conversation is clearly complete, ` +
      `call ${HANG_UP_TOOL}. The first call arms hangup and asks you to say goodbye; after ` +
      `the goodbye, call it once more to end the phone call.`,
    `Do not call ${CONSULT_TOOL} for greetings, caller identity at call start, or generic chat.`,
  );

  return lines.join("\n");
}

// The instruction for the proactive opening line — calls must never start
// with silence. Inbound gets a short greeting; outbound leads with why the
// call was placed.
export function buildVoiceGreeting(meta: CallMeta): string {
  if (meta.direction === "outbound") {
    if (meta.openingMessage) {
      return `Open the call now. Say this naturally as your first turn: ${meta.openingMessage}`;
    }
    if (meta.purpose) {
      return `Open the call now by explaining why you are calling: ${meta.purpose}`;
    }
    return "Open the call now: identify yourself briefly and explain why you are calling.";
  }
  const name = meta.contact.contactName;
  return name
    ? `Greet the caller now, briefly and warmly, by name (${name}), and ask how you can help.`
    : "Greet the caller now, briefly and neutrally, and ask how you can help.";
}
