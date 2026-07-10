// In-memory dedup guards for the webhook gateway. Providers retry aggressively
// (network flaps, slow handlers), so every inbound event is claimed by request
// id before dispatch and only committed once handled. Purely in-memory: a
// restart may reprocess a recent event, which downstream handling tolerates.

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 10_000;
// An in-flight claim represents active processing, not a completed record, so
// it is held far longer than the committed TTL — a dispatch that outlives the
// committed window must stay claimed so a provider retry can't double-process
// it. This is only a backstop against a handler that never commits/rolls back.
const INFLIGHT_TTL_MS = 3_600_000;

export interface RequestDedup {
  // Claim an id for processing. Returns false when the id is already
  // in-flight or was committed within the TTL; missing ids always pass.
  begin(id: string | undefined): boolean;
  // Mark a claimed id as handled so retries short-circuit until the TTL lapses.
  commit(id: string | undefined): void;
  // Release a claimed id after a failure so the provider's retry can run.
  rollback(id: string | undefined): void;
}

export interface NotifyOnce {
  // True the first time a key is seen within the TTL, false until it lapses.
  shouldNotify(key: string | undefined): boolean;
}

export function createRequestDedup(
  opts: { ttlMs?: number; maxEntries?: number } = {},
): RequestDedup {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // id -> timestamp; Map iteration order doubles as insertion order, so the
  // first key is always the oldest and eviction is O(evicted).
  const inflight = new Map<string, number>();
  const recent = new Map<string, number>();

  function prune(): void {
    const now = Date.now();
    for (const [id, at] of recent) {
      if (now - at >= ttlMs) recent.delete(id);
    }
    for (const [id, at] of inflight) {
      if (now - at >= INFLIGHT_TTL_MS) inflight.delete(id);
    }
    while (recent.size > maxEntries) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  }

  return {
    begin(id) {
      if (!id) return true;
      prune();
      if (inflight.has(id) || recent.has(id)) return false;
      inflight.set(id, Date.now());
      return true;
    },
    commit(id) {
      if (!id) return;
      inflight.delete(id);
      recent.set(id, Date.now());
      prune();
    },
    rollback(id) {
      if (!id) return;
      inflight.delete(id);
    },
  };
}

// Once-per-TTL guard keyed per event (e.g. "text:<id>", "imessage:<id>"),
// used so a repeatedly-webhooked delivery failure wakes the agent only once.
export function createNotifyOnce(opts: { ttlMs?: number } = {}): NotifyOnce {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const notified = new Map<string, number>();

  return {
    shouldNotify(key) {
      if (!key) return true;
      const now = Date.now();
      for (const [k, at] of notified) {
        if (now - at >= ttlMs) notified.delete(k);
      }
      if (notified.has(key)) return false;
      notified.set(key, now);
      return true;
    },
  };
}
