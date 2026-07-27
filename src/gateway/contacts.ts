import type { Contact } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import type { Channel, GatewayLogger, SenderAgentIdentity } from "./types.js";

// Contact identity for an inbound sender. Empty when the address does not
// resolve to exactly one contact (missing, ambiguous, or lookup failure).
export interface ResolvedContact {
  contactId?: string;
  contactName?: string;
  contactCompany?: string;
  contactEmails?: string[];
  contactPhones?: string[];
  // Free-form notes from the contact record. Injected into voice-call
  // instructions only — never into per-message frame tags (can be long).
  contactNotes?: string;
}

// One-line contact card for [inkbox:...] frame tags: the addresses the agent
// may use for this person. A contactless sender resolved to a peer agent
// identity is labeled with that identity; otherwise unresolved senders are
// marked explicitly so the model asks or looks the person up instead of
// guessing an address.
export function contactCard(c: ResolvedContact, agent?: SenderAgentIdentity): string {
  if (!c.contactId) {
    if (agent) {
      // Handle and display name are remote-controlled strings — quote both.
      const parts = [`contact_agent_identity_id=${agent.id}`];
      if (agent.handle) parts.push(`contact_agent_handle=${JSON.stringify(agent.handle)}`);
      if (agent.displayName) parts.push(`contact_name=${JSON.stringify(agent.displayName)}`);
      return parts.join(" ");
    }
    return "contact=unknown_in_inkbox";
  }
  const parts = [`contact_id=${c.contactId}`];
  if (c.contactName) parts.push(`contact_name=${JSON.stringify(c.contactName)}`);
  if (c.contactCompany) parts.push(`contact_company=${JSON.stringify(c.contactCompany)}`);
  if (c.contactEmails?.length) parts.push(`contact_emails=${c.contactEmails.join(",")}`);
  if (c.contactPhones?.length) parts.push(`contact_phones=${c.contactPhones.join(",")}`);
  return parts.join(" ");
}

export interface ChatKeyInput {
  contactId?: string;
  channel: Exclude<Channel, "voice">;
  threadId?: string;
  conversationId?: string;
  from: string;
}

export interface ContactResolver {
  resolve(address: string): Promise<ResolvedContact>;
  chatKeyFor(input: ChatKeyInput): string;
}

export const DEFAULT_CONTACT_CACHE_TTL_MS = 300_000;

// Canonical cache/session form of a sender address: email case is
// insignificant and E.164 numbers have no case, so trim + lowercase.
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function contactDisplayName(contact: Contact): string | undefined {
  const preferred = contact.preferredName?.trim();
  if (preferred) return preferred;
  const full = [contact.givenName, contact.familyName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return full || undefined;
}

// Spoken-friendly summary of contact cards for direct reads on a live call.
export function describeContacts(contacts: Contact[], max = 5): string {
  if (contacts.length === 0) return "No matching contacts found.";
  const lines = contacts.slice(0, max).map((c) => {
    const name = contactDisplayName(c) ?? "Unnamed contact";
    const bits = [c.companyName?.trim() ? `company ${c.companyName.trim()}` : ""];
    const emails = (c.emails ?? []).map((e) => e.value).filter(Boolean);
    const phones = (c.phones ?? []).map((p) => p.value).filter(Boolean);
    if (emails.length) bits.push(`email ${emails.join(", ")}`);
    if (phones.length) bits.push(`phone ${phones.join(", ")}`);
    const notes = c.notes?.trim();
    if (notes) bits.push(`notes: ${notes.length > 200 ? `${notes.slice(0, 200)}…` : notes}`);
    return `${name} — ${bits.filter(Boolean).join("; ") || "no details on file"}`;
  });
  if (contacts.length > max) lines.push(`…and ${contacts.length - max} more matches.`);
  return lines.join("\n");
}

// Resolves inbound sender addresses to organization contacts and derives the
// per-human session key.
export function createContactResolver(
  deps: { inkbox: InkboxRuntime; logger: GatewayLogger },
  opts: { cacheTtlMs?: number } = {},
): ContactResolver {
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CONTACT_CACHE_TTL_MS;
  const cache = new Map<string, { value: ResolvedContact; expiresAt: number }>();

  async function lookup(address: string): Promise<ResolvedContact> {
    const kind = address.includes("@") ? "email" : "phone";
    try {
      const client = await deps.inkbox.getClient();
      const matches = await client.contacts.lookup(
        kind === "email" ? { email: address } : { phone: address },
      );
      // Only an unambiguous single match counts; zero or many is a miss.
      if (matches.length !== 1) return {};
      const contact = matches[0];
      const name = contactDisplayName(contact);
      const company = contact.companyName?.trim();
      const emails = (contact.emails ?? []).map((e) => e.value).filter(Boolean);
      const phones = (contact.phones ?? []).map((p) => p.value).filter(Boolean);
      const notes = contact.notes?.trim();
      return {
        contactId: contact.id,
        ...(name ? { contactName: name } : {}),
        ...(company ? { contactCompany: company } : {}),
        ...(emails.length ? { contactEmails: emails } : {}),
        ...(phones.length ? { contactPhones: phones } : {}),
        ...(notes ? { contactNotes: notes } : {}),
      };
    } catch (error) {
      // Resolution must never drop a message: warn and fall through to the
      // channel-thread key. The failure is cached like a miss, so this logs
      // once per address per TTL window.
      deps.logger.warn("gateway: contact lookup failed", {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  return {
    async resolve(address) {
      const key = normalizeAddress(address);
      if (!key) return {};
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await lookup(key);
      // Misses (and failures) are cached too, so a chatty unresolved sender
      // costs one lookup per TTL window instead of one per message.
      cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
      return value;
    },

    chatKeyFor(input) {
      // A resolved contact id IS the chat key: one human converges on one
      // session no matter which channel they use.
      if (input.contactId) return input.contactId;
      // Unresolved senders stay stable per channel conversation.
      const thread = (input.channel === "email" ? input.threadId : input.conversationId)?.trim();
      if (thread) return `${input.channel}:${thread}`;
      return normalizeAddress(input.from);
    },
  };
}
