import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboundEmailIds, isExactEmailReplyBody, newInboundEmailFrom } from "../live/helpers.js";

const mailbox = "driver@example.com";
const sender = "agent@example.com";
const now = new Date("2026-09-19T12:00:00Z");
const since = new Date(now.getTime() - 5 * 60_000).toISOString();

function row(id: number, from = "other@example.com", snippet = "unrelated") {
  return {
    id: `message-${id}`,
    from_address: from,
    subject: "reply",
    snippet,
    direction: "inbound",
    created_at: since,
  };
}

function mailboxWithHistory() {
  const baseline = Array.from({ length: 65 }, (_, index) => row(index + 1));
  baseline[44] = row(45, sender, "CONFIRMED stale response");
  const state = { rows: baseline, pages: [] as { offset: number; since: string | null }[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toMatch(/\/messages$/);
      expect(url.searchParams.get("direction")).toBe("inbound");
      expect(url.searchParams.get("start_datetime")).toBe(since);
      const offset = Number(url.searchParams.get("cursor") || 0);
      const limit = Number(url.searchParams.get("limit"));
      state.pages.push({ offset, since: url.searchParams.get("start_datetime") });
      const more = offset + limit < state.rows.length;
      return Response.json({
        items: state.rows.slice(offset, offset + limit),
        has_more: more,
        next_cursor: more ? String(offset + limit) : null,
      });
    }),
  );
  return {
    client: new Inkbox({ apiKey: "synthetic-key", baseUrl: "https://api.example.com" }),
    state,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live email polling", () => {
  it("allows only the exact authored answer and the documented transport footer", () => {
    const expected = "CONFIRMED current-run";
    const footer = "\n\nSent via Inkbox (https://inkbox.ai)";
    expect(isExactEmailReplyBody(expected, expected)).toBe(true);
    expect(isExactEmailReplyBody(expected + footer, expected)).toBe(true);
    expect(isExactEmailReplyBody((expected + footer).replaceAll("\n", "\r\n"), expected)).toBe(
      true,
    );
    for (const body of [
      `Here is your answer: ${expected}`,
      `${expected} plus additional content`,
      `${expected}${footer} plus additional content`,
      `${expected}${footer}${footer}`,
      `${expected}\n\nSent by a different service`,
      `CONFIRMED old-run${footer}`,
      "CONFIRMED", // The current nonce only in an inherited subject is insufficient.
    ])
      expect(isExactEmailReplyBody(body, expected)).toBe(false);
  });

  it("keeps the inclusive bound on every SDK page through a delayed reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { client, state } = mailboxWithHistory();
    const boundary = new Date(Date.now() - 5 * 60_000).toISOString();
    const before = await inboundEmailIds(client, mailbox, boundary);
    const tag = "smoke-current-run";
    const accept = (message: { snippet?: string }) =>
      (message.snippet ?? "").includes("CONFIRMED") && (message.snippet ?? "").includes(tag);
    await expect(
      newInboundEmailFrom(client, mailbox, sender, before, boundary, accept),
    ).resolves.toBeUndefined();

    vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
    state.rows = [...state.rows, row(66, sender, `CONFIRMED ${tag}`)];
    const reply = await newInboundEmailFrom(client, mailbox, sender, before, boundary, accept);
    expect(reply?.id).toBe("message-66");
    expect(before.size).toBe(65);
    expect(state.pages).toEqual(
      [0, 30, 60, 0, 30, 60, 0, 30, 60].map((offset) => ({ offset, since: boundary })),
    );
  });

  it("cannot accept a stale matching email beyond the first baseline page", async () => {
    const { client, state } = mailboxWithHistory();
    const before = await inboundEmailIds(client, mailbox, since);
    const reply = await newInboundEmailFrom(client, mailbox, sender, before, since, (message) =>
      (message.snippet ?? "").includes("CONFIRMED"),
    );
    expect(reply).toBeUndefined();
    expect(before.size).toBe(65);
    expect(state.pages.map((page) => page.offset)).toEqual([0, 30, 60, 0, 30, 60]);
  });
});
