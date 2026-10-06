import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultGatewayConfig } from "../../src/config.js";
import { channelReadiness } from "../../src/gateway/channel-readiness.js";
import { createStateStore } from "../../src/gateway/state.js";
import { SLACK_SUBSCRIPTION_EVENTS } from "../../src/slack.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "channel-readiness-"));
  dirs.push(dir);
  const store = createStateStore(dir);
  const identity = {
    id: "identity",
    imessageEnabled: true,
    getIMessage: vi.fn(async () => ({ conversationId: "conversation" })),
    getIMessageThread: vi.fn(async () => ({
      conversationId: "conversation",
      messages: [{ text: "private history" }],
    })),
  };
  const client = {
    slack: {
      listConnections: vi.fn(async () => ({
        connections: [
          {
            id: "connection",
            identityId: "identity",
            workspaceId: "workspace",
            status: "connected",
          },
        ],
      })),
    },
    webhooks: {
      subscriptions: {
        list: vi.fn(async () => [
          {
            agentIdentityId: "identity",
            status: "active",
            url: "https://gateway.example/webhook",
            eventTypes: [...SLACK_SUBSCRIPTION_EVENTS],
          },
        ]),
      },
    },
  };
  const runtime = {
    getIdentity: vi.fn(async () => identity),
    getClient: vi.fn(async () => client),
  };
  const config: any = {
    gateway: { ...defaultGatewayConfig(), publicUrl: "https://gateway.example" },
  };
  return {
    store,
    identity,
    client,
    runtime,
    config,
    check: () => channelReadiness(config, runtime as any, store),
  };
}
it("disabled channels require no SDK calls or backend claims", async () => {
  const d = setup();
  expect((await d.check()).every((finding) => finding.message.endsWith("disabled."))).toBe(true);
  expect(d.runtime.getIdentity).not.toHaveBeenCalled();
  expect(d.runtime.getClient).not.toHaveBeenCalled();
});
it("distinguishes missing SDK, absent source, and failed backend verification", async () => {
  const d = setup();
  d.config.gateway.imessageThreadedReplies = true;
  expect(await d.check()).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("backend remains unverified"),
    }),
  );
  d.store.saveTurn({
    id: "turn",
    messageID: "input",
    chatKey: "chat",
    state: "delivered",
    kind: "normal",
    deliver: true,
    text: "private request",
    replyTarget: {
      channel: "imessage",
      imessageSource: { messageId: "source", conversationId: "conversation" },
    },
    createdAt: 1,
    updatedAt: 1,
  });
  const verified = await d.check();
  expect(verified).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("bounded native endpoint verified"),
    }),
  );
  expect(JSON.stringify(verified)).not.toContain("private");
  expect(d.identity.getIMessageThread).toHaveBeenCalledWith("source", { limit: 1 });
  d.identity.getIMessageThread.mockRejectedValueOnce(new Error("unsupported endpoint"));
  expect(await d.check()).toContainEqual(
    expect.objectContaining({
      severity: "error",
      message: expect.stringContaining("verification unavailable"),
    }),
  );
  (d.identity as any).getIMessageThread = undefined;
  expect(await d.check()).toContainEqual(
    expect.objectContaining({ severity: "error", message: expect.stringContaining("SDK lacks") }),
  );
});
it("accepts only owned connected workspaces and active exact-route event coverage", async () => {
  const d = setup();
  d.config.gateway.slackEnabled = true;
  expect((await d.check()).filter((finding) => finding.severity === "error")).toEqual([]);
  d.client.slack.listConnections.mockResolvedValue({
    connections: [
      { id: "foreign", identityId: "other", workspaceId: "workspace", status: "connected" },
    ],
  });
  d.client.webhooks.subscriptions.list.mockResolvedValue([
    {
      agentIdentityId: "other",
      status: "active",
      url: "https://gateway.example/webhook",
      eventTypes: [...SLACK_SUBSCRIPTION_EVENTS],
    },
  ]);
  expect((await d.check()).filter((finding) => finding.severity === "error")).toHaveLength(2);
  d.client.webhooks.subscriptions.list.mockResolvedValue([
    {
      agentIdentityId: "identity",
      status: "paused",
      url: "https://gateway.example/webhook",
      eventTypes: [...SLACK_SUBSCRIPTION_EVENTS],
    },
  ]);
  expect(await d.check()).toContainEqual(
    expect.objectContaining({ severity: "error", message: expect.stringContaining("lack active") }),
  );
  d.config.gateway.publicUrl = undefined;
  expect(await d.check()).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("subscription readiness is unverified"),
    }),
  );
});
