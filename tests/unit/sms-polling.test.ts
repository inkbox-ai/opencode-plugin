import { Inkbox } from "@inkbox/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { outboundTexts } from "../live/helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reads every SMS page and recipient within the frozen window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  const since = "2026-01-01T11:55:00.000Z";
  const pages: Array<{ offset: number; since: string | null; until: string | null }> = [];
  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: `message-${index}`,
    direction: "outbound",
    created_at: since,
    text: "unrelated",
    remote_phone_number: index === 200 ? "+15555550999" : "+15555550123",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const offset = Number(url.searchParams.get("offset"));
      pages.push({
        offset,
        since: url.searchParams.get("start_datetime"),
        until: url.searchParams.get("end_datetime"),
      });
      // Simulate advancing time between SDK pages without moving their bounds.
      vi.setSystemTime(new Date(Date.now() + 60_000));
      return Response.json(rows.slice(offset, offset + Number(url.searchParams.get("limit"))));
    }),
  );
  const client = new Inkbox({ apiKey: "synthetic-key", baseUrl: "https://api.example.com" });
  const baseline = await outboundTexts(client, "number", since);
  expect(baseline).toHaveLength(201);
  expect(baseline.at(-1)?.remotePhoneNumber).toBe("+15555550999");
  vi.setSystemTime(new Date("2026-01-01T12:10:00Z"));
  const delayed = await outboundTexts(client, "number", since);
  expect(delayed).toHaveLength(201);
  expect(pages).toEqual([
    { offset: 0, since, until: "2026-01-01T12:00:00.000Z" },
    { offset: 200, since, until: "2026-01-01T12:00:00.000Z" },
    { offset: 0, since, until: "2026-01-01T12:10:00.000Z" },
    { offset: 200, since, until: "2026-01-01T12:10:00.000Z" },
  ]);
});
