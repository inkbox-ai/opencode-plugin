// Live: a remote identity texts the AUT's dedicated number and a real reply
// comes back over SMS. Inter-agent traffic needs no carrier opt-in.
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  askOverSms,
  client,
  LIVE,
  mailboxOf,
  nonce,
  phoneOf,
  REAL_MODEL,
  REMOTE_KEY,
  TIMEOUT_MS,
} from "./helpers.js";

describe.skipIf(!LIVE)("live sms reply", () => {
  it("mock model: the nonce travels inbound → model → reply → delivery", {
    timeout: TIMEOUT_MS + 90_000,
    skip: REAL_MODEL,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const autPhone = await phoneOf(aut);
    const remotePhone = await phoneOf(remote);

    const tag = nonce();
    const body = await askOverSms(
      remote,
      remotePhone.id,
      autPhone.number,
      `ping ${tag}`,
      (reply) => reply.includes("REPLY_OK") && reply.includes(tag),
    );
    expect(body.includes("REPLY_OK") && body.includes(tag)).toBe(true);
  });

  it("real model: reports its own identity when asked", {
    timeout: TIMEOUT_MS + 90_000,
    skip: !REAL_MODEL,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const autPhone = await phoneOf(aut);
    const remotePhone = await phoneOf(remote);
    const autEmail = await mailboxOf(aut);
    const tag = nonce();

    const body = await askOverSms(
      remote,
      remotePhone.id,
      autPhone.number,
      `Reply with your Inkbox email address and this exact reference: ${tag}`,
      (reply) => reply.toLowerCase().includes(autEmail.toLowerCase()) && reply.includes(tag),
    );
    expect(body.toLowerCase().includes(autEmail.toLowerCase()) && body.includes(tag)).toBe(true);
  });
});
