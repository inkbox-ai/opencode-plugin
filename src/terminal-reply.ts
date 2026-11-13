import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RemoteMcp, type RemoteToolResult } from "@inkbox/sdk/remote-mcp";
import type { InkboxRuntime } from "./client.js";
import type { DurableTurn } from "./gateway/state.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function replySource(event: DurableTurn): boolean {
  return (
    (!event.companion && event.replyTarget?.channel === "email" && !!event.replyTarget.messageId) ||
    (!event.companion &&
      event.replyTarget?.channel === "sms" &&
      !event.replyTarget.group &&
      !!event.replyTarget.to)
  );
}
export function replyJournal(home: string, event: DurableTurn): string {
  return join(home, "remote-replies", hash(event.chatKey));
}
const sourceHash = (event: DurableTurn) =>
  hash([event.replyTarget?.channel, event.replyTarget?.messageId ?? event.id]);

export async function replyState(
  runtime: InkboxRuntime,
  event: DurableTurn,
  home: string,
): Promise<"none" | "accepted" | "uncertain"> {
  if (!replySource(event) || !existsSync(replyJournal(home, event))) return "none";
  try {
    const client = await runtime.getClient();
    const identity = await runtime.getIdentity();
    const remote = new RemoteMcp({
      apiKey: client._apiKey,
      baseUrl: client._baseUrl,
      identity: identity.id,
      journalPath: replyJournal(home, event),
    });
    const record = remote.terminalReplies().lookup(sourceHash(event));
    return record?.state === "accepted"
      ? "accepted"
      : record?.state === "pending" && record.submitted
        ? "uncertain"
        : "none";
  } catch {
    console.warn("[inkbox] Terminal reply receipt unavailable; automatic reply withheld");
    return "uncertain";
  }
}

export async function sendTerminalReply(
  remote: RemoteMcp,
  runtime: InkboxRuntime,
  event: DurableTurn,
  text: string,
  validate: () => Promise<void>,
  home: string,
  call: (
    name: string,
    args: Record<string, unknown>,
    operation: string,
    journal: string,
    submit: () => Promise<void>,
  ) => Promise<RemoteToolResult>,
): Promise<RemoteToolResult> {
  if (!replySource(event) || !text.trim() || text.length > 12000)
    throw new Error("A terminal reply needs an admitted message and bounded text");
  await validate();
  const source = sourceHash(event);
  const operation = `terminal:${source}:${hash(text).slice(0, 32)}`;
  const path = replyJournal(home, event);
  const journal = remote.terminalReplies({ journalPath: path });
  const prior = journal.lookup(source);
  if (prior?.state === "accepted")
    return {
      content: [{ type: "text", text: "The terminal reply was already accepted." }],
      structuredContent: { accepted_id: prior.acceptedId },
    };
  let name: string;
  let args: Record<string, unknown>;
  let to: string[],
    cc: string[] = [];
  if (event.replyTarget?.channel === "email") {
    const identity = await runtime.getIdentity();
    const original = await identity.getMessage(event.replyTarget.messageId!);
    if (
      original.id !== event.replyTarget.messageId ||
      original.direction !== "inbound" ||
      !original.replyAllRecipients
    )
      throw new Error("The original email reply destination is unavailable");
    to = original.replyAllRecipients.to;
    cc = original.replyAllRecipients.cc;
    name = "inkbox_email_reply";
    args = {
      message_id: event.replyTarget.messageId,
      reply_all: true,
      approved_recipients: { to, cc, bcc: [] },
      body_text: text,
      idempotency_key: operation,
    };
  } else {
    to = [event.replyTarget!.to!];
    name = "inkbox_text_send";
    args = { to, text: text, idempotency_key: operation };
  }
  await validate();
  journal.reserve(source, operation, hash([name, args]));
  try {
    const result = await call(name, args, operation, path, async () => {
      await validate();
      journal.markSubmitted(source, operation);
    });
    if (result.isError) {
      if (!journal.lookup(source)?.submitted) journal.reject(source, operation);
      return result;
    }
    const receipt = result.structuredContent;
    if (!receipt) throw new Error("The terminal reply outcome is unconfirmed");
    const email = event.replyTarget?.channel === "email";
    const acceptedId = email ? receipt.id : receipt.message_id;
    const accepted = email
      ? receipt.direction === "outbound" && receipt.is_blocked !== true
      : ["queued", "sent", "delivered"].includes(String(receipt.delivery_status)) && !receipt.error;
    if (!accepted || typeof acceptedId !== "string" || !acceptedId)
      throw new Error("The terminal reply outcome is unconfirmed");
    const equal = (actual: unknown, expected: string[], email = false) =>
      Array.isArray(actual) &&
      actual.every((value) => typeof value === "string") &&
      JSON.stringify(
        [...new Set(actual.map((value) => (email ? value.toLowerCase() : value)))].sort(),
      ) ===
        JSON.stringify(
          [...new Set(expected.map((value) => (email ? value.toLowerCase() : value)))].sort(),
        );
    if (
      email
        ? !equal(receipt.to_addresses, to, true) || !equal(receipt.cc_addresses ?? [], cc, true)
        : !equal(receipt.recipients, to)
    )
      throw new Error("The terminal reply destination is unconfirmed");
    journal.accept(source, operation, acceptedId);
    return result;
  } catch (error) {
    const current = journal.lookup(source);
    if (current?.state === "pending" && !current.submitted) journal.reject(source, operation);
    throw error;
  }
}
