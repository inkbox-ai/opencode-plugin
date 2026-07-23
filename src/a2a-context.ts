export interface ActiveA2ATurn {
  taskId: string;
  messageId: string;
  contextId: string;
  replyIntentCommitted: boolean;
}

const turns = new Map<string, ActiveA2ATurn>();

export function setActiveA2ATurn(sessionID: string, turn: ActiveA2ATurn): void {
  turns.set(sessionID, turn);
}

export function clearActiveA2ATurn(sessionID: string, turn: ActiveA2ATurn): void {
  if (turns.get(sessionID) === turn) turns.delete(sessionID);
}

export function activeA2ATurn(sessionID: string): ActiveA2ATurn | undefined {
  return turns.get(sessionID);
}
