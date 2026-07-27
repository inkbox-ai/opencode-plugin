import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayHome } from "./gateway/state.js";

export interface ActiveA2ATurn {
  taskId: string;
  messageId: string;
  contextId: string;
  replyIntentCommitted: boolean;
}

const turns = new Map<string, ActiveA2ATurn>();

export function a2aTurnContextPath(sessionID: string): string {
  const digest = crypto.createHash("sha256").update(sessionID).digest("hex");
  return path.join(gatewayHome(), "a2a-turn-contexts", `${digest}.json`);
}

function sameTurn(left: ActiveA2ATurn, right: ActiveA2ATurn): boolean {
  return (
    left.taskId === right.taskId &&
    left.messageId === right.messageId &&
    left.contextId === right.contextId
  );
}

function readTurn(sessionID: string): ActiveA2ATurn | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(a2aTurnContextPath(sessionID), "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.taskId !== "string" ||
      typeof value.messageId !== "string" ||
      typeof value.contextId !== "string" ||
      typeof value.replyIntentCommitted !== "boolean"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function writeTurn(sessionID: string, turn: ActiveA2ATurn): void {
  const target = a2aTurnContextPath(sessionID);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(turn)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

export function setActiveA2ATurn(sessionID: string, turn: ActiveA2ATurn): void {
  turns.set(sessionID, turn);
  writeTurn(sessionID, turn);
}

export function clearActiveA2ATurn(sessionID: string, turn: ActiveA2ATurn): void {
  if (turns.get(sessionID) === turn) turns.delete(sessionID);
  const persisted = readTurn(sessionID);
  if (!persisted || !sameTurn(persisted, turn)) return;
  turn.replyIntentCommitted = persisted.replyIntentCommitted;
  try {
    fs.unlinkSync(a2aTurnContextPath(sessionID));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function activeA2ATurn(sessionID: string): ActiveA2ATurn | undefined {
  return turns.get(sessionID) ?? readTurn(sessionID);
}

export function commitActiveA2ATurn(sessionID: string, turn: ActiveA2ATurn): void {
  turn.replyIntentCommitted = true;
  writeTurn(sessionID, turn);
}
