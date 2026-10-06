import { isPermissionReply, sameAuthor } from "./response-policy.js";

export interface ReplyAuthor {
  sender: string;
  channel: string;
  route?: string;
}
export interface PendingReplies {
  await(chatKey: string, timeoutMs: number, author?: ReplyAuthor): Promise<string | undefined>;
  ask(
    chatKey: string,
    timeoutMs: number,
    author: ReplyAuthor | undefined,
    send: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  tryConsume(chatKey: string, text: string, author?: ReplyAuthor): boolean;
  pending(chatKey: string): boolean;
  cancel(chatKey: string): void;
  cancelFor(chatKey: string, author: ReplyAuthor): boolean;
  close(): void;
}
interface Waiter {
  author?: ReplyAuthor;
  done(text?: string): void;
}
export function createPendingReplies(): PendingReplies {
  const waiters = new Map<string, Waiter>();
  const queues = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();
  let closed = false;
  function wait(chatKey: string, timeoutMs: number, author?: ReplyAuthor) {
    if (closed || waiters.has(chatKey)) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Waiter = {
        author,
        done(text) {
          if (timer) clearTimeout(timer);
          if (waiters.get(chatKey) === entry) waiters.delete(chatKey);
          resolve(text);
        },
      };
      waiters.set(chatKey, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => entry.done(), timeoutMs);
        timer.unref?.();
      }
    });
  }
  function cancel(chatKey: string) {
    generations.set(chatKey, (generations.get(chatKey) ?? 0) + 1);
    waiters.get(chatKey)?.done();
  }
  return {
    await: wait,
    async ask(chatKey, timeoutMs, author, send, signal) {
      const generation = generations.get(chatKey) ?? 0;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
      const run = async () => {
        if (
          closed ||
          signal?.aborted ||
          generation !== (generations.get(chatKey) ?? 0) ||
          Date.now() >= deadline
        )
          return;
        const answer = wait(chatKey, Number.isFinite(deadline) ? deadline - Date.now() : 0, author);
        const own = waiters.get(chatKey);
        const cancelOwn = () => {
          if (waiters.get(chatKey) === own) own?.done();
        };
        signal?.addEventListener("abort", cancelOwn, { once: true });
        try {
          if (!signal?.aborted) await send();
          return await answer;
        } finally {
          signal?.removeEventListener("abort", cancelOwn);
          cancelOwn();
        }
      };
      const previous = queues.get(chatKey);
      const task = previous ? previous.catch(() => {}).then(run) : run();
      queues.set(chatKey, task);
      try {
        return await task;
      } finally {
        if (queues.get(chatKey) === task) queues.delete(chatKey);
      }
    },
    tryConsume(chatKey, text, author) {
      if (!isPermissionReply(text)) return false;
      const entry = waiters.get(chatKey);
      if (!entry) return false;
      const expected = entry.author;
      if (
        expected &&
        (!author ||
          author.channel !== expected.channel ||
          author.route !== expected.route ||
          !sameAuthor(expected.channel, expected.sender, author.sender))
      )
        return false;
      entry.done(text);
      return true;
    },
    pending: (chatKey) => waiters.has(chatKey),
    cancel,
    cancelFor(chatKey, author) {
      const expected = waiters.get(chatKey)?.author;
      if (
        !waiters.has(chatKey) ||
        (expected &&
          (expected.channel !== author.channel ||
            expected.route !== author.route ||
            !sameAuthor(expected.channel, expected.sender, author.sender)))
      )
        return false;
      cancel(chatKey);
      return true;
    },
    close() {
      closed = true;
      for (const key of new Set([...waiters.keys(), ...queues.keys()])) cancel(key);
    },
  };
}
