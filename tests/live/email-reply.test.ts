// Live: a remote identity emails the AUT and a real reply comes back.
// Mock leg proves the whole pipe (webhook → session → model → delivery) with
// zero token spend; the real leg proves the agent actually reasons.
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  assertNotErrorReply,
  client,
  inboundEmailIds,
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
    const before = await inboundEmailIds(remote, remoteEmail);
    await remote.messages.send(remoteEmail, {
      to: [autEmail],
      subject: `Reachability probe ${tag}`,
      bodyText: `Automated reachability probe. Please reply. ${tag}`,
    });

    const reply = await pollUntil("email reply", () =>
      newInboundEmailFrom(remote, remoteEmail, autEmail, before, (message) => {
        const content = `${message.subject ?? ""}\n${message.snippet ?? ""}`;
        return content.includes("REPLY_OK") && content.includes(tag);
      }),
    );
    const body = `${reply.subject ?? ""}\n${reply.snippet ?? ""}`;
    assertNotErrorReply(body, "email");
    expect(body).toContain("REPLY_OK");
    expect(body).toContain(tag);
  });

  it("real model: replies with actual content", {
    timeout: TIMEOUT_MS + 60_000,
    skip: !REAL_MODEL,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const remoteEmail = await mailboxOf(remote);
    const autEmail = await mailboxOf(aut);

    const before = await inboundEmailIds(remote, remoteEmail);
    await remote.messages.send(remoteEmail, {
      to: [autEmail],
      subject: "Quick check",
      bodyText: "Please reply with the single word CONFIRMED and nothing else.",
    });

    const reply = await pollUntil("email reply", () =>
      newInboundEmailFrom(remote, remoteEmail, autEmail, before, (message) =>
        `${message.subject ?? ""}\n${message.snippet ?? ""}`.toLowerCase().includes("confirmed"),
      ),
    );
    const body = `${reply.subject ?? ""}\n${reply.snippet ?? ""}`;
    assertNotErrorReply(body, "email");
    expect(body.toLowerCase()).toContain("confirmed");
  });
});
