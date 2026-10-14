import { randomUUID } from "node:crypto";
import type { V2Client } from "./v2-connection.js";

export async function requestApproval(
  client: V2Client,
  input: {
    sessionID: string;
    messageID: string;
    callID: string;
    agent: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  },
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const signals = [signal, controller.signal];
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  const combined = AbortSignal.any(signals);
  const id = `per_${randomUUID()}`;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveReply!: (reply: string) => void;
  let rejectReply!: (error: unknown) => void;
  const reply = new Promise<string>((resolve, reject) => {
    resolveReply = resolve;
    rejectReply = reject;
  });
  void reply.catch(() => {});
  const reader = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: combined })) {
        if (event.type === "server.connected") resolveReady();
        if (
          event.type === "permission.replied" &&
          event.data.sessionID === input.sessionID &&
          event.data.requestID === id
        )
          resolveReply(event.data.reply);
      }
      throw new Error("OpenCode approval connection ended.");
    } catch (error) {
      rejectReady(error);
      rejectReply(error);
    }
  })();
  let pending = false;
  try {
    await ready;
    combined.throwIfAborted();
    pending = true;
    const result = await client.permission.create(
      {
        id,
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.permission,
        resources: input.patterns,
        save: input.always,
        metadata: JSON.parse(JSON.stringify(input.metadata)),
        source: { type: "tool", messageID: input.messageID, id: input.callID },
      },
      { signal: combined },
    );
    pending = result.effect === "ask";
    if (result.effect === "deny") throw new Error("Outbound request was declined.");
    if (pending) {
      const decision = await reply;
      pending = false;
      if (decision !== "once" && decision !== "always")
        throw new Error("Outbound request was declined.");
    }
    combined.throwIfAborted();
  } finally {
    if (pending)
      await client.permission
        .reply(
          { sessionID: input.sessionID, requestID: id, decision: "reject" },
          { signal: AbortSignal.timeout(3000) },
        )
        .catch(() => {});
    controller.abort();
    await reader;
  }
}
