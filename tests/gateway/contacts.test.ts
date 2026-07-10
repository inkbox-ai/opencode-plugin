import { afterEach, describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { createContactResolver, DEFAULT_CONTACT_CACHE_TTL_MS } from "../../src/gateway/contacts.js";
import type { GatewayLogger } from "../../src/gateway/types.js";

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "contact-1",
    preferredName: "Ada Lovelace",
    givenName: "Ada",
    familyName: "Lovelace",
    emails: [{ value: "ada@example.com", label: "work", isPrimary: true }],
    phones: [],
    ...overrides,
  };
}

function makeDeps(lookup: ReturnType<typeof vi.fn>) {
  const client = { contacts: { lookup } };
  const inkbox = {
    getIdentity: vi.fn(async () => ({})),
    getClient: vi.fn(async () => client),
  } as unknown as InkboxRuntime;
  const logger: GatewayLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { inkbox, logger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createContactResolver", () => {
  describe("resolve", () => {
    it("resolves a single email match to its contact card", async () => {
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({
        contactId: "contact-1",
        contactName: "Ada Lovelace",
        contactEmails: ["ada@example.com"],
      });
      expect(lookup).toHaveBeenCalledWith({ email: "ada@example.com" });
    });

    it("looks up E.164 senders by phone instead of email", async () => {
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup));
      await resolver.resolve("+15551234567");
      expect(lookup).toHaveBeenCalledWith({ phone: "+15551234567" });
    });

    it("falls back to given + family name when no preferred name is set", async () => {
      const lookup = vi.fn(async () => [makeContact({ preferredName: null })]);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({
        contactId: "contact-1",
        contactName: "Ada Lovelace",
        contactEmails: ["ada@example.com"],
      });
    });

    it("omits contactName when the contact has no usable name parts", async () => {
      const lookup = vi.fn(async () => [
        makeContact({ preferredName: null, givenName: null, familyName: null, emails: [] }),
      ]);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({
        contactId: "contact-1",
      });
    });

    it("treats an ambiguous multi-contact match as a miss", async () => {
      const lookup = vi.fn(async () => [makeContact(), makeContact({ id: "contact-2" })]);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({});
    });

    it("serves repeat lookups from cache, keyed by trimmed lowercased address", async () => {
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup));
      const first = await resolver.resolve("Ada@Example.com");
      const second = await resolver.resolve("  ADA@EXAMPLE.COM  ");
      expect(first).toEqual(second);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith({ email: "ada@example.com" });
    });

    it("caches misses so an unknown sender costs one SDK call", async () => {
      const lookup = vi.fn(async () => []);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("stranger@example.com")).resolves.toEqual({});
      await expect(resolver.resolve("stranger@example.com")).resolves.toEqual({});
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("returns {} on lookup failure and logs a single warning per TTL window", async () => {
      const lookup = vi.fn(async () => {
        throw new Error("lookup exploded");
      });
      const deps = makeDeps(lookup);
      const resolver = createContactResolver(deps);
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({});
      await expect(resolver.resolve("ada@example.com")).resolves.toEqual({});
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(deps.logger.warn).toHaveBeenCalledTimes(1);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "gateway: contact lookup failed",
        expect.objectContaining({ kind: "email" }),
      );
    });

    it("still yields a usable fallback chat key after a failed lookup", async () => {
      const lookup = vi.fn(async () => {
        throw new Error("lookup exploded");
      });
      const resolver = createContactResolver(makeDeps(lookup));
      const resolved = await resolver.resolve("+15551234567");
      expect(resolved).toEqual({});
      const key = resolver.chatKeyFor({
        ...resolved,
        channel: "sms",
        conversationId: "conv-1",
        from: "+15551234567",
      });
      expect(key).toBe("sms:conv-1");
    });

    it("re-fetches once the default 300s TTL expires", async () => {
      vi.useFakeTimers();
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup));
      await resolver.resolve("ada@example.com");
      vi.advanceTimersByTime(DEFAULT_CONTACT_CACHE_TTL_MS - 1);
      await resolver.resolve("ada@example.com");
      expect(lookup).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      await resolver.resolve("ada@example.com");
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("honors a custom cacheTtlMs", async () => {
      vi.useFakeTimers();
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup), { cacheTtlMs: 1_000 });
      await resolver.resolve("ada@example.com");
      vi.advanceTimersByTime(1_001);
      await resolver.resolve("ada@example.com");
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("skips the SDK entirely for a blank address", async () => {
      const lookup = vi.fn(async () => [makeContact()]);
      const resolver = createContactResolver(makeDeps(lookup));
      await expect(resolver.resolve("   ")).resolves.toEqual({});
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("chatKeyFor", () => {
    const resolver = createContactResolver(makeDeps(vi.fn()));

    it("uses the resolved contact id as the chat key on every channel", () => {
      const email = resolver.chatKeyFor({
        contactId: "contact-1",
        channel: "email",
        threadId: "thread-1",
        from: "ada@example.com",
      });
      const sms = resolver.chatKeyFor({
        contactId: "contact-1",
        channel: "sms",
        conversationId: "conv-1",
        from: "+15551234567",
      });
      const imessage = resolver.chatKeyFor({
        contactId: "contact-1",
        channel: "imessage",
        conversationId: "conv-2",
        from: "+15551234567",
      });
      expect(email).toBe("contact-1");
      expect(sms).toBe("contact-1");
      expect(imessage).toBe("contact-1");
    });

    it("falls back to email:<threadId> for unresolved email senders", () => {
      const key = resolver.chatKeyFor({
        channel: "email",
        threadId: "thread-1",
        from: "ada@example.com",
      });
      expect(key).toBe("email:thread-1");
    });

    it("falls back to sms:<conversationId> for unresolved SMS senders", () => {
      const key = resolver.chatKeyFor({
        channel: "sms",
        conversationId: "conv-1",
        from: "+15551234567",
      });
      expect(key).toBe("sms:conv-1");
    });

    it("falls back to imessage:<conversationId> for unresolved iMessage senders", () => {
      const key = resolver.chatKeyFor({
        channel: "imessage",
        conversationId: "conv-2",
        from: "+15551234567",
      });
      expect(key).toBe("imessage:conv-2");
    });

    it("keys by the normalized sender address when no thread context exists", () => {
      const key = resolver.chatKeyFor({
        channel: "email",
        from: "  Ada@Example.COM ",
      });
      expect(key).toBe("ada@example.com");
    });

    it("ignores a whitespace-only thread id and uses the sender address", () => {
      const key = resolver.chatKeyFor({
        channel: "sms",
        conversationId: "   ",
        from: "+15551234567",
      });
      expect(key).toBe("+15551234567");
    });
  });
});
