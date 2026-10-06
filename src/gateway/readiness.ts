import { createStateStore, type StateStore } from "./state.js";

export function queueReadiness(store: StateStore = createStateStore()) {
  const inventory = store.read().permissionInventory as { ready?: boolean } | undefined;
  const turns = store.listTurns();
  const unconfirmed = turns.filter((turn) => turn.uncertainStage || turn.state === "paused");
  const blocked = unconfirmed.filter((turn) => !turn.executionFenced);
  const pending = turns.filter((turn) =>
    ["hydrating", "queued", "submitting", "submitted", "completed", "delivery_started"].includes(
      turn.state,
    ),
  );
  return {
    ready: blocked.length === 0 && inventory?.ready !== false,
    permissionInventoryReady: inventory?.ready !== false,
    pending: pending.length,
    unconfirmed: unconfirmed.length,
    blockedConversations: new Set(blocked.map((turn) => turn.chatKey)).size,
    oldestPendingAgeSeconds: pending.length
      ? Math.max(
          0,
          Math.floor((Date.now() - Math.min(...pending.map((turn) => turn.createdAt))) / 1000),
        )
      : null,
  };
}
