import type { Contact } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import type { Channel, GatewayLogger } from "./types.js";

// Contact identity for an inbound sender. Empty when the address does not
// resolve to exactly one contact (missing, ambiguous, or lookup failure).
export interface ResolvedContact {
  contactId?: string;
  contactName?: string;
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

// Resolves inbound sender addresses to Inkbox contacts and derives the
// per-human session key. With an agent-scoped key, lookup results are
// already access-filtered server-side.
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
      const name = contactDisplayName(matches[0]);
      return { contactId: matches[0].id, ...(name ? { contactName: name } : {}) };
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
