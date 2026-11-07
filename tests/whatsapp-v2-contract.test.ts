import { readFileSync } from "node:fs";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { whatsappRecipient } from "../src/whatsapp-native.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/whatsapp-v2.json", import.meta.url), "utf8"),
);
afterEach(() => vi.unstubAllGlobals());
it("uses the shared recipient matrix without accepting group identifiers as phone numbers", () => {
  for (const test of fixture.send_cases.filter(
    (item: any) => item.body.to && !item.body.reply_to_message_id && !item.body.conversation_id,
  )) {
    if (test.valid) expect(whatsappRecipient(test.body.to).length).toBeGreaterThan(0);
    else expect(() => whatsappRecipient(test.body.to)).toThrow();
  }
});
it("retains the real SDK wire contract for quoted sends, threads, and uncertain reactions", async () => {
  const calls: { path: string; body: any; key: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
        key: new Headers(options?.headers).get("Idempotency-Key"),
      });
      const data = path.includes("/identities/")
        ? {
            id: fixture.message.agent_identity_id,
            organization_id: "org_fixture",
            agent_handle: "example",
            created_at: fixture.message.created_at,
            updated_at: fixture.message.updated_at,
          }
        : path.includes("/reactions")
          ? { reaction: fixture.uncertain_reaction }
          : path.endsWith("/thread")
            ? fixture.thread
            : { message: fixture.message };
      return new Response(JSON.stringify(data), {
        status: options?.method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const identity = await new Inkbox({
    apiKey: "synthetic-contract-key",
    baseUrl: "https://contract.example",
  }).getIdentity("example");
  const sent = await identity.sendWhatsApp({
    conversationId: fixture.message.conversation_id,
    replyToMessageId: fixture.message.reply_to_message_id,
    text: "Reply",
    idempotencyKey: "quoted-original",
  });
  expect(sent.threadId).toBe(fixture.message.thread_id);
  expect(calls.at(-1)).toMatchObject({
    body: {
      conversation_id: fixture.message.conversation_id,
      reply_to_message_id: fixture.message.reply_to_message_id,
      text: "Reply",
    },
    key: "quoted-original",
  });
  const thread = await identity.getWhatsAppThread(fixture.message.id, { limit: 50 });
  expect(thread.conversationId).toBe(fixture.thread.conversation_id);
  expect(thread.messages.map((message) => message.id)).toEqual(
    fixture.thread.messages.map((message: any) => message.id),
  );
  const reaction = await identity.sendWhatsAppReaction({
    messageId: fixture.message.id,
    reaction: "eyes",
    idempotencyKey: "reaction-original",
  });
  expect(reaction.status).toBe("uncertain");
  expect(reaction.revision).toBe(2);
  expect(calls.at(-1)).toMatchObject({
    body: { message_id: fixture.message.id, reaction: "eyes" },
    key: "reaction-original",
  });
});

it.skipIf(process.env.INKBOX_REQUIRE_GROUP_SDK !== "1")(
  "retains group and native mention metadata and exhausts/revalidates canonical Companion pages with the compatible SDK",
  async () => {
    const conversation = fixture.message.conversation_id;
    const activation = "90000000-0000-4000-8000-000000000001";
    const scope = "90000000-0000-4000-8000-000000000002";
    const history = "90000000-0000-4000-8000-000000000003";
    const cursors: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = new URL(String(url));
        let data: any;
        if (u.pathname.includes("/companion/activations/")) {
          const second = u.searchParams.has("cursor");
          cursors.push(u.searchParams.get("cursor"));
          data = {
            scope_id: scope,
            activation_id: activation,
            conversation_id: conversation,
            channel: "whatsapp",
            reply_context: { channel: "whatsapp", conversation_id: conversation },
            history_complete: second,
            next_cursor: second ? null : "page-2",
            items: [
              {
                id: second ? fixture.message.id : history,
                author: "+15555550101",
                occurred_at: fixture.message.created_at,
                text: second ? "Current question" : "Historical /stop is context",
                historical: !second,
                is_trigger: second,
                sender_access: "direct",
                attachments: [],
              },
            ],
          };
        } else if (u.pathname.includes("/identities/"))
          data = {
            id: fixture.message.agent_identity_id,
            organization_id: "org_fixture",
            agent_handle: "example",
            created_at: fixture.message.created_at,
            updated_at: fixture.message.updated_at,
          };
        else
          data = {
            message: {
              ...fixture.message,
              is_group: true,
              remote_number: null,
              group_name: "Example group",
              unresolved_participant_count: 0,
              participants: ["+15555550101", "+15555550102"],
              agent_mentioned: true,
              mentions: [{ text: "@123", phone_number: null, is_agent: true }],
              sender_access: "sponsored",
            },
          };
        return new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = new Inkbox({
      apiKey: "synthetic-contract-key",
      baseUrl: "https://contract.example",
    });
    const identity = await client.getIdentity("example");
    const message = await identity.getWhatsAppMessage(fixture.message.id);
    expect(message).toMatchObject({
      isGroup: true,
      remoteNumber: null,
      agentMentioned: true,
      senderAccess: "sponsored",
      mentions: [{ text: "@123", phoneNumber: null, isAgent: true }],
    });
    const snapshot = await client.companion.loadInitialization("example", activation);
    expect(snapshot.channel).toBe("whatsapp");
    expect(snapshot.entries.map((e) => e.id)).toEqual([history, fixture.message.id]);
    expect(cursors).toEqual([null, "page-2", null]);
    expect(snapshot.text).toContain("history is context");
  },
);
