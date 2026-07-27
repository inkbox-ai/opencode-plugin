import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayHome } from "./gateway/state.js";

export interface A2ADelegationRecord {
  identityId: string;
  origin: string;
  cardUrl: string;
  contextId?: string;
  taskId?: string;
  messageId: string;
  sessionId?: string;
  updatedAt: number;
}

type Records = Record<string, A2ADelegationRecord>;

function filePath(): string {
  return path.join(gatewayHome(), "a2a-delegations.json");
}

function origin(url: string): string {
  return new URL(url).origin.toLowerCase();
}

function read(): Records {
  try {
    const loaded = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    return loaded && typeof loaded === "object" ? loaded : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function write(records: Records): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

export function recordBeforeSend(input: {
  identityId: string;
  rpcUrl: string;
  cardUrl: string;
  contextId?: string;
  taskId?: string;
  messageId: string;
  sessionId?: string;
}): string {
  const resolvedOrigin = origin(input.rpcUrl);
  const contextKey = input.contextId ?? `pending:${input.messageId}`;
  const key = `${input.identityId}|${resolvedOrigin}|${contextKey}`;
  const records = read();
  records[key] = {
    identityId: input.identityId,
    origin: resolvedOrigin,
    cardUrl: input.cardUrl,
    contextId: input.contextId,
    taskId: input.taskId,
    messageId: input.messageId,
    sessionId: input.sessionId,
    updatedAt: Date.now(),
  };
  write(records);
  return key;
}

export function promoteAfterSend(pendingKey: string, contextId: string, taskId: string): void {
  const records = read();
  const record = records[pendingKey];
  if (!record) return;
  delete records[pendingKey];
  record.contextId = contextId;
  record.taskId = taskId;
  record.updatedAt = Date.now();
  records[`${record.identityId}|${record.origin}|${contextId}`] = record;
  write(records);
}

export function findDelegationByTask(taskId: string): A2ADelegationRecord | undefined {
  return Object.values(read())
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
