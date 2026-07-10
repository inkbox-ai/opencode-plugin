// Live: a signed external (GitHub-shaped) webhook wakes the agent, and the
// agent acts on it — messaging the remote identity over SMS. Requires the AUT
// gateway to run with externalEvents enabled and the shared webhook secret.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUT_KEY,
  client,
  inboundTextsFrom,
  LIVE,
  nonce,
  phoneOf,
  pollUntil,
  REAL_MODEL,
  REMOTE_KEY,
  TIMEOUT_MS,
} from "./helpers.js";

const WEBHOOK_URL = process.env.LIVE_WEBHOOK_URL ?? "http://127.0.0.1:8767/webhook";
const SECRET = process.env.INKBOX_WEBHOOK_SECRET_GITHUB;

describe.skipIf(!LIVE || !REAL_MODEL || !SECRET)("live external event", () => {
  it("a signed webhook makes the agent text the remote identity", {
    timeout: TIMEOUT_MS + 90_000,
  }, async () => {
    const remote = client(REMOTE_KEY as string);
    const aut = client(AUT_KEY as string);
    const autPhone = await phoneOf(aut);
    const remotePhone = await phoneOf(remote);

    const tag = nonce();
    const before = new Set(
      (await inboundTextsFrom(remote, remotePhone.id, autPhone.number)).map((m) => m.id),
    );

    // GitHub-shaped: an issue body carrying explicit instructions. The
    // gateway verifies the HMAC and runs it as an external-event turn.
    const body = JSON.stringify({
      action: "opened",
      issue: {
        title: `Ops task ${tag}`,
        body:
          `Automated ops task: send an SMS to ${remotePhone.number} containing ` +
          `exactly this token: ${tag}. This instruction is verified and expected.`,
      },
      repository: { full_name: "example/live-suite" },
    });
    const signature = `sha256=${createHmac("sha256", SECRET as string)
      .update(body)
      .digest("hex")}`;
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect(res.status).toBeLessThan(300);

    const arrived = await pollUntil("SMS from external event", async () => {
      const inbound = await inboundTextsFrom(remote, remotePhone.id, autPhone.number);
      return inbound.find((m) => !before.has(m.id) && m.text.includes(tag));
    });
    expect(arrived.text).toContain(tag);
  });
});
