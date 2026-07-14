// Live provider/session coverage for GitHub webhooks. Voice tests own real
// call behavior; this suite verifies HMAC rejection/acceptance and completion
// of the resulting real-model capture turn without depending on the model
// obeying arbitrary prose embedded in a webhook body.
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LIVE, pollUntil, REAL_MODEL, TIMEOUT_MS } from "./helpers.js";

const WEBHOOK_URL = process.env.LIVE_WEBHOOK_URL ?? "http://127.0.0.1:8767/webhook";
const SECRET = process.env.INKBOX_WEBHOOK_SECRET_GITHUB;
const GATEWAY_LOG = process.env.AUT_GATEWAY_LOG;

async function gatewayLog(): Promise<string> {
  if (!GATEWAY_LOG) return "";
  return readFile(GATEWAY_LOG, "utf8").catch(() => "");
}

function workflowRunBody(runId: string): string {
  const repository = process.env.GITHUB_REPOSITORY ?? "inkbox-ai/opencode-plugin";
  return JSON.stringify({
    action: "completed",
    workflow_run: {
      id: runId,
      name: "CI",
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      html_url: `https://github.com/${repository}/actions/runs/${runId}`,
    },
    repository: { full_name: repository },
  });
}

async function post(body: string, signature: string, requestId: string): Promise<Response> {
  return fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/live-test",
      "x-github-event": "workflow_run",
      "x-github-delivery": randomBytes(16).toString("hex"),
      "x-inkbox-request-id": requestId,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

describe.skipIf(!LIVE || !REAL_MODEL || !SECRET || !GATEWAY_LOG)("live external event", () => {
  it("rejects forged GitHub hooks and completes a valid real-model turn", {
    timeout: TIMEOUT_MS + 90_000,
  }, async () => {
    const forgedRequestId = randomBytes(12).toString("hex");
    const forgedBody = workflowRunBody(randomBytes(8).toString("hex"));
    const forgedMarker = `external.turn_completed:github:${forgedRequestId}`;
    const forged = await post(forgedBody, "sha256=deadbeef", forgedRequestId);
    expect(forged.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await gatewayLog()).not.toContain(forgedMarker);

    const validRequestId = randomBytes(12).toString("hex");
    const validBody = workflowRunBody(randomBytes(8).toString("hex"));
    const signature = `sha256=${createHmac("sha256", SECRET as string)
      .update(validBody)
      .digest("hex")}`;
    const valid = await post(validBody, signature, validRequestId);
    expect(valid.status).toBeLessThan(300);
    expect(JSON.parse(await valid.text())).toMatchObject({ ok: true });

    const marker = `external.turn_completed:github:${validRequestId}`;
    await pollUntil("external event model turn", async () =>
      (await gatewayLog()).includes(marker) ? true : undefined,
    );
    expect(await gatewayLog()).toContain(marker);
  });
});
