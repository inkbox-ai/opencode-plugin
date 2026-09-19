// Live: a remote identity emails the AUT and a real reply comes back.
// Mock leg proves the whole pipe (webhook → session → model → delivery) with
// zero token spend; the real leg proves the agent actually reasons.
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  assertNotErrorReply,
  client,
  inboundEmailIds,
  isExactEmailReplyBody,
  LIVE,
  mailboxOf,
  newInboundEmailFrom,
  nonce,
  pollUntil,
  REAL_MODEL,
  REMOTE_KEY,
  TIMEOUT_MS,
} from "./helpers.js";

describe.skipIf(!LIVE)("live email reply", () => {
  it("mock model: the nonce travels inbound → model → reply → delivery", {
    timeout: TIMEOUT_MS + 60_000,
    skip: REAL_MODEL,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const remoteEmail = await mailboxOf(remote);
    const autEmail = await mailboxOf(aut);

    const tag = nonce();
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const before = await inboundEmailIds(remote, remoteEmail, since);
    await remote.messages.send(remoteEmail, {
      to: [autEmail],
      subject: `Reachability probe ${tag}`,
      bodyText: `Automated reachability probe. Please reply. ${tag}`,
    });

    const reply = await pollUntil("email reply", () =>
      newInboundEmailFrom(remote, remoteEmail, autEmail, before, since, (message) => {
        const content = message.snippet ?? "";
        return content.includes("REPLY_OK") && content.includes(tag);
      }),
    );
    const detail = await remote.messages.get(remoteEmail, reply.id);
    const body = detail.bodyText ?? "";
    assertNotErrorReply(body, "email");
    expect(body.includes("REPLY_OK") && body.includes(tag)).toBe(true);
  });

  it("real model: replies with actual content", {
    timeout: TIMEOUT_MS + 60_000,
    skip: !REAL_MODEL,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const remoteEmail = await mailboxOf(remote);
    const autEmail = await mailboxOf(aut);

    const tag = nonce();
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const before = await inboundEmailIds(remote, remoteEmail, since);
    await remote.messages.send(remoteEmail, {
      to: [autEmail],
      subject: `Quick check ${tag}`,
      bodyText: `Please reply with exactly CONFIRMED ${tag} and nothing else.`,
    });

    const reply = await pollUntil("email reply", () =>
      newInboundEmailFrom(remote, remoteEmail, autEmail, before, since, (message) => {
        const content = (message.snippet ?? "").toLowerCase();
        return content.includes("confirmed") && content.includes(tag);
      }),
    );
    const detail = await remote.messages.get(remoteEmail, reply.id);
    const body = detail.bodyText ?? "";
    assertNotErrorReply(body, "email");
    expect(
      isExactEmailReplyBody(body, `CONFIRMED ${tag}`),
      "Email response must contain only the requested answer and optional standard transport footer",
    ).toBe(true);
  });
});
