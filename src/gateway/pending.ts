// Coordinates escalation with inbound routing: when a session is waiting on
// a human's answer (a relayed permission question), the contact's NEXT
// inbound message is consumed as that answer instead of starting a new turn.
export interface PendingReplies {
  // Wait for the next inbound message for this chatKey. Resolves with the
  // message text, or undefined on timeout.
  await(chatKey: string, timeoutMs: number): Promise<string | undefined>;
  // Called by dispatch for every inbound message. Returns true if the
  // message was consumed as a pending answer (so no turn should start).
  tryConsume(chatKey: string, text: string): boolean;
  pending(chatKey: string): boolean;
}

export function createPendingReplies(): PendingReplies {
  const waiters = new Map<string, (text: string | undefined) => void>();

  return {
    await(chatKey, timeoutMs) {
      // A second escalation for the same chatKey supersedes the first.
      waiters.get(chatKey)?.(undefined);
      return new Promise<string | undefined>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (text: string | undefined) => {
          if (timer) clearTimeout(timer);
          if (waiters.get(chatKey) === done) waiters.delete(chatKey);
          resolve(text);
        };
        waiters.set(chatKey, done);
        if (timeoutMs > 0) {
          timer = setTimeout(() => done(undefined), timeoutMs);
          timer.unref?.();
        }
      });
    },
    tryConsume(chatKey, text) {
      const waiter = waiters.get(chatKey);
      if (!waiter) return false;
      waiter(text);
      return true;
    },
    pending(chatKey) {
      return waiters.has(chatKey);
    },
  };
}
