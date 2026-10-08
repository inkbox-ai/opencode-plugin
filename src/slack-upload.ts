import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { InkboxRuntime } from "./client.js";
import { createStateStore, type StateStore } from "./gateway/state.js";
import { ownSlackConnection, type SlackRoute, slackRouteKey } from "./slack.js";

const MAX_BYTES = 10 * 1024 * 1024;
export interface SlackUploadArgs {
  connectionId: string;
  conversationId: string;
  filePath: string;
  filename?: string;
  title?: string;
  initialComment?: string;
  threadTs?: string | null;
  idempotencyKey: string;
}
type Source = { callId: string; turnId?: string; ownerId?: string; route?: SlackRoute };
type UploadRecord = {
  sourceKey: string;
  fingerprint: string;
  state: "started" | "result";
  result?: unknown;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validateLocalPath(filePath: string) {
  if (!filePath || /^(https?:|data:|file:)/i.test(filePath) || filePath.includes("\0"))
    throw new Error("Provide a local file path, not a URL or base64.");
}

/** Read one regular local file with a hard allocation/read cap, including a growth sentinel. */
export async function readSlackFile(filePath: string, directory: string) {
  validateLocalPath(filePath);
  const handle = await open(
    resolve(directory, filePath),
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES)
      throw new Error("Slack files must be regular files of 1 byte to 10 MiB.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > MAX_BYTES) throw new Error("Slack file changed size or exceeds 10 MiB.");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
function assertOwner(source: Source, ctx: ToolContext, store: StateStore) {
  if (ctx.abort.aborted) throw new Error("The originating tool was stopped.");
  if (!source.turnId) return;
  const turn = store.getTurn(source.turnId);
  if (
    !turn ||
    turn.ownerId !== source.ownerId ||
    !turn.ownerId ||
    (turn.leaseUntil ?? 0) <= Date.now() ||
    !["submitting", "submitted"].includes(turn.state) ||
    turn.executionFenced ||
    !turn.replyTarget?.slack ||
    slackRouteKey(turn.replyTarget.slack) !== slackRouteKey(source.route!) ||
    turn.replyTarget.slack.sourceEventId !== source.route!.sourceEventId
  )
    throw new Error("The originating Slack turn no longer owns this upload.");
}
/** Resolve the host's call and parent, rather than accepting model-authored source IDs. */
export async function slackUploadSource(
  args: SlackUploadArgs,
  ctx: ToolContext,
  client: OpencodeClient | undefined,
  store: StateStore,
): Promise<Source> {
  if (!client || !ctx.sessionID || !ctx.messageID)
    throw new Error("Native tool-call ownership is unavailable.");
  const response = await client.session.message({
    path: { id: ctx.sessionID, messageID: ctx.messageID },
    query: { directory: ctx.directory },
  });
  const message = response.data;
  if (response.error || message?.info.role !== "assistant")
    throw new Error("Native tool-call source is unavailable.");
  const calls = message.parts.filter(
    (part: any) =>
      part.type === "tool" &&
      part.tool === "inkbox_slack_upload_file" &&
      ["pending", "running"].includes(part.state?.status) &&
      part.state.input?.idempotencyKey === args.idempotencyKey,
  );
  if (calls.length !== 1 || !(calls[0] as any).callID)
    throw new Error("Native upload tool call is missing or ambiguous.");
  const call = calls[0] as any;
  if (Object.keys(args).some((key) => args[key as keyof SlackUploadArgs] !== call.state.input[key]))
    throw new Error("Native upload arguments changed.");
  const turns = store
    .listTurns()
    .filter(
      (turn) =>
        turn.sessionID === ctx.sessionID &&
        turn.messageID === (message.info as any).parentID &&
        turn.replyTarget?.slack,
    );
  if (turns.length > 1) throw new Error("Native upload source is ambiguous.");
  const turn = turns[0];
  if (!turn) {
    const session = await client.session.get({
      path: { id: ctx.sessionID },
      query: { directory: ctx.directory },
    });
    if (
      session.error ||
      !session.data ||
      session.data.id !== ctx.sessionID ||
      session.data.parentID
    )
      throw new Error(
        "Child-session uploads must be delivered by the original source-owning parent turn.",
      );
  }
  const source = {
    callId: call.callID,
    turnId: turn?.id,
    ownerId: turn?.ownerId,
    route: turn?.replyTarget?.slack,
  };
  assertOwner(source, ctx, store);
  return source;
}
export async function uploadSlackFile(
  deps: {
    runtime: InkboxRuntime;
    opencode?: OpencodeClient;
    enabled(): boolean;
    approve(file: { path: string; filename: string }): Promise<void>;
    store?: StateStore;
  },
  args: SlackUploadArgs,
  ctx: ToolContext,
) {
  const store = deps.store ?? createStateStore();
  const source = await slackUploadSource(args, ctx, deps.opencode, store);
  const client = await deps.runtime.getClient(),
    identity = await deps.runtime.getIdentity();
  if (source.route && source.route.identityId !== identity.id)
    throw new Error("The originating Slack identity changed.");
  // An upload to the active conversation always retains its immutable original thread.
  const same =
    source.route?.connectionId === args.connectionId &&
    source.route.conversationId === args.conversationId;
  if (same && args.threadTs !== undefined && (args.threadTs ?? null) !== source.route!.threadTs)
    throw new Error("An active-source upload cannot switch Slack threads.");
  const threadTs = same ? source.route!.threadTs : (args.threadTs ?? null);
  const check = async () => {
    if (!deps.enabled()) throw new Error("Slack is disabled.");
    assertOwner(source, ctx, store);
    if (source.route && !same)
      await ownSlackConnection(
        client,
        identity.id,
        source.route.connectionId,
        source.route.workspaceId,
        source.route.connectionGeneration,
      );
    await ownSlackConnection(
      client,
      identity.id,
      args.connectionId,
      same ? source.route!.workspaceId : undefined,
      same ? source.route!.connectionGeneration : undefined,
    );
    assertOwner(source, ctx, store);
  };
  await check();
  validateLocalPath(args.filePath);
  const resolved = await realpath(resolve(ctx.directory, args.filePath));
  const bytes = await readSlackFile(resolved, ctx.directory);
  const filename = args.filename ?? basename(args.filePath);
  if (
    !filename ||
    filename.length > 255 ||
    Array.from(filename).some((char) => char.charCodeAt(0) < 32) ||
    /[/\\]/.test(filename)
  )
    throw new Error("Slack filename must be a simple filename of 1–255 characters.");
  await check();
  await deps.approve({ path: resolved, filename });
  await check();
  const payload = {
    conversationId: args.conversationId,
    filename,
    contentBase64: bytes.toString("base64"),
    threadTs,
    title: args.title,
    initialComment: args.initialComment,
  };
  const fingerprint = hash([args.connectionId, payload]);
  const sourceKey = hash([identity.id, ctx.sessionID, source.turnId ?? ctx.messageID]);
  // No content or file path is persisted. One host tool call has exactly one effect, even if a caller changes keys.
  const key = hash([
    identity.id,
    ctx.sessionID,
    ctx.messageID,
    source.callId,
    source.route?.sourceEventId ?? null,
  ]);
  let previous: UploadRecord | undefined;
  store.updateSlackSend(key, (old) => {
    assertOwner(source, ctx, store);
    const records = Object.values((store.read().slackSends ?? {}) as Record<string, UploadRecord>);
    previous =
      (old as UploadRecord | undefined) ??
      records.find((entry) => entry.sourceKey === sourceKey && entry.fingerprint === fingerprint);
    return previous ?? { sourceKey, fingerprint, state: "started" };
  });
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new Error("The upload payload changed for an existing native tool call.");
    if (previous.state === "result") return { ...(previous.result as object), deduplicated: true };
    throw new Error(
      "This upload has an unconfirmed outcome; do not resend it. Inspect its operation if known.",
    );
  }
  const result = await client.slack.uploadFile(args.connectionId, {
    ...payload,
    idempotencyKey: `opencode:upload:${key}`,
  });
  store.updateSlackSend(key, () => ({ sourceKey, fingerprint, state: "result", result }));
  return result;
}
