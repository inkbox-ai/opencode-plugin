import type { ActiveA2ATurn } from "../a2a-context.js";
import { findDelegationByTask } from "../a2a-delegations.js";
import {
  acknowledgeA2AProgressDrain,
  clearA2AProgressDrain,
  listA2AProgressDrains,
  registerA2AProgressDrain,
  renewA2AProgressDrain,
  requestA2AProgressDrain,
} from "../a2a-progress.js";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import type { StateStore } from "./state.js";
import type { GatewayLogger, SessionManager, VerifiedEvent } from "./types.js";

const TURN_STOPPED = new Set([
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
const REQUESTER_WAKE_STATES = new Set([
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
const INBOUND_TASK_DIRECTIVE =
  "You are handling an inbound A2A task. Resolve it with inkbox_a2a_complete, " +
  "inkbox_a2a_ask_caller, or inkbox_a2a_fail. When caller input is needed, use " +
  "inkbox_a2a_ask_caller and wait for the caller instead of completing the task.";
const ACK_TEMPLATE = "Task {taskId} received. Work is queued and starting.";
const RETRY_MS = 5_000;
const DRAIN_STALE_MS = 5_000;

interface A2AEventData {
  task_id: string;
  context_id: string;
  state?: string;
  message_id?: string;
  caller?: {
    identity_id?: string;
    organization_id?: string;
    handle?: string;
  };
  parts?: Array<Record<string, unknown>>;
}

interface RegistryEntry {
  taskId: string;
  contextId: string;
  messageId: string;
  state: "queued" | "running" | "finalized";
  data: A2AEventData;
  replyIntentFenced?: boolean;
  generation?: number;
  createdAt: number;
  updatedAt: number;
}

interface ProgressRecord {
  taskId: string;
  contextId: string;
  startedAt: number;
  nextDueAt: number;
  active: boolean;
  acknowledgementText: string;
  acknowledgementDelivered: boolean;
  pendingText?: string;
  lastDeliveredText?: string;
  deliveredCount: number;
  updatedAt: number;
}

interface ProgressRuntime {
  stopping: boolean;
  wake?: () => void;
  loop?: Promise<void>;
  unregister?: () => void;
  monitor?: NodeJS.Timeout;
  coordinating?: boolean;
  coordinatedTokens?: Set<string>;
  staleObservations?: Map<string, { heartbeatAt: number; observedAt: number }>;
}

export interface A2AHandler {
  handles(event: VerifiedEvent): boolean;
  handle(event: VerifiedEvent): Promise<boolean>;
  catchUp(): Promise<void>;
  close(): Promise<void>;
}

function eventData(event: VerifiedEvent): A2AEventData | undefined {
  const data = event.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = data as A2AEventData;
  return value.task_id && value.context_id ? value : undefined;
}

function registry(state: StateStore): Record<string, RegistryEntry> {
  const value = state.read().a2aTasks;
  return value && typeof value === "object" ? (value as Record<string, RegistryEntry>) : {};
}

function progressRegistry(state: StateStore): Record<string, ProgressRecord> {
  const value = state.read().a2aProgress;
  return value && typeof value === "object" ? (value as Record<string, ProgressRecord>) : {};
}

function isA2AApiUnavailable(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404) ||
    /\bHTTP 404\b/.test(String(error))
  );
}

function normalizedState(value: unknown): string {
  return String((value as { value?: unknown } | undefined)?.value ?? value ?? "")
    .toLowerCase()
    .replace(/^task_state_/, "");
}

function persist(
  state: StateStore,
  key: string,
  data: A2AEventData,
  status: RegistryEntry["state"],
): void {
  const current = registry(state);
  const now = Date.now();
  const generation =
    current[key]?.generation ??
    Object.values(current).reduce((latest, entry) => Math.max(latest, entry.generation ?? 0), 0) +
      1;
  state.update({
    a2aTasks: {
      ...current,
      [key]: {
        taskId: data.task_id,
        contextId: data.context_id,
        messageId: data.message_id ?? "",
        state: status,
        data,
        replyIntentFenced: current[key]?.replyIntentFenced,
        generation,
        createdAt: current[key]?.createdAt ?? now,
        updatedAt: now,
      },
    },
  });
}

function fenceReplyIntent(state: StateStore, key: string): void {
  const current = registry(state);
  const entry = current[key];
  if (!entry || entry.replyIntentFenced) return;
  state.update({
    a2aTasks: {
      ...current,
      [key]: { ...entry, replyIntentFenced: true, updatedAt: Date.now() },
    },
  });
}

function latestTaskEntry(state: StateStore, taskId: string): RegistryEntry | undefined {
  return Object.values(registry(state))
    .filter((entry) => entry.taskId === taskId)
    .sort(
      (left, right) =>
        (right.generation ?? right.createdAt ?? right.updatedAt) -
        (left.generation ?? left.createdAt ?? left.updatedAt),
    )[0];
}

function saveProgress(state: StateStore, record: ProgressRecord): void {
  const current = progressRegistry(state);
  const next = { ...current, [record.taskId]: { ...record, updatedAt: Date.now() } };
  const inactive = Object.values(next)
    .filter((item) => !item.active)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const stale of inactive.slice(200)) delete next[stale.taskId];
  state.update({ a2aProgress: next });
}

export function a2aAcknowledgementText(taskId: string, intervalSeconds: number): string {
  const receipt = ACK_TEMPLATE.replace("{taskId}", taskId);
  if (intervalSeconds <= 0) return `${receipt} Periodic progress updates are disabled.`;
  const minutes = intervalSeconds / 60;
  if (intervalSeconds >= 60 && Number.isInteger(minutes)) {
    return `${receipt} Expect progress updates about every ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return `${receipt} Expect progress updates about every ${intervalSeconds} ${intervalSeconds === 1 ? "second" : "seconds"}.`;
}

function messageText(message: any): string {
  return (message?.parts ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function workerTexts(task: any): string[] {
  const messages = Array.isArray(task?.messages)
    ? task.messages
    : Array.isArray(task?.raw?.history)
      ? task.raw.history
      : [];
  return messages
    .filter((message: any) => {
      const role = normalizedState(message?.role);
      return role === "agent" || role === "role_agent";
    })
    .map(messageText)
    .filter(Boolean);
}

function advanceDue(previousDue: number, now: number, intervalMs: number): number {
  let next = previousDue;
  while (next <= now) next += intervalMs;
  return next;
}

export function createA2AHandler(deps: {
  inkbox: InkboxRuntime;
  sessions: SessionManager;
  state: StateStore;
  logger: GatewayLogger;
  config?: ResolvedConfig;
}): A2AHandler {
  interface RunningJob {
    key: string;
    taskId: string;
    contextId: string;
    task: Promise<void>;
  }
  const running = new Map<string, RunningJob>();
  const progressRuntimes = new Map<string, ProgressRuntime>();
  const taskLocks = new Map<string, Promise<void>>();
  const settlingTasks = new Set<string>();
  const retryWaiters = new Map<string, Set<() => void>>();
  const intervalSeconds = deps.config?.gateway.a2aProgressIntervalSeconds ?? 180;
  const intervalMs = intervalSeconds * 1000;
  let closing = false;

  async function identity(): Promise<any> {
    return deps.inkbox.getIdentity() as Promise<any>;
  }

  async function serializeTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = taskLocks.get(taskId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    taskLocks.set(taskId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskLocks.get(taskId) === queued) taskLocks.delete(taskId);
    }
  }

  async function waitForRetry(taskId: string, delayMs: number): Promise<void> {
    if (closing || settlingTasks.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = retryWaiters.get(taskId) ?? new Set<() => void>();
      let timer: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0 && retryWaiters.get(taskId) === waiters) {
          retryWaiters.delete(taskId);
        }
        resolve();
      };
      timer = setTimeout(finish, delayMs);
      timer.unref?.();
      waiters.add(finish);
      retryWaiters.set(taskId, waiters);
    });
  }

  function wakeRetryWaiters(taskId?: string): void {
    const waiters = taskId
      ? [...(retryWaiters.get(taskId) ?? [])]
      : [...retryWaiters.values()].flatMap((taskWaiters) => [...taskWaiters]);
    for (const finish of waiters) finish();
  }

  function ensureProgressRecord(data: A2AEventData): ProgressRecord {
    const existing = progressRegistry(deps.state)[data.task_id];
    if (existing) {
      if (existing.contextId !== data.context_id || !existing.active) {
        if (!existing.active) {
          clearA2AProgressDrain(data.task_id);
          settlingTasks.delete(data.task_id);
        }
        const updated = { ...existing, contextId: data.context_id, active: true };
        saveProgress(deps.state, updated);
        return updated;
      }
      return existing;
    }
    const createdAt = Object.values(registry(deps.state))
      .filter((entry) => entry.taskId === data.task_id)
      .map((entry) => entry.createdAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .reduce((earliest, value) => Math.min(earliest, value), Date.now());
    const record: ProgressRecord = {
      taskId: data.task_id,
      contextId: data.context_id,
      startedAt: createdAt,
      nextDueAt: createdAt + intervalMs,
      active: true,
      acknowledgementText: a2aAcknowledgementText(data.task_id, intervalSeconds),
      acknowledgementDelivered: false,
      deliveredCount: 0,
      updatedAt: Date.now(),
    };
    clearA2AProgressDrain(data.task_id);
    saveProgress(deps.state, record);
    return record;
  }

  async function ensureAcknowledgement(data: A2AEventData): Promise<boolean> {
    return serializeTask(data.task_id, async () => {
      let progress = ensureProgressRecord(data);
      if (closing || settlingTasks.has(data.task_id)) return false;
      if (progress.acknowledgementDelivered) return true;
      const id = await identity();
      const task = await id.a2aTask(data.task_id);
      if (TURN_STOPPED.has(normalizedState(task.state))) return false;
      if (closing || settlingTasks.has(data.task_id)) return false;
      if (workerTexts(task).includes(progress.acknowledgementText)) {
        progress = { ...progress, acknowledgementDelivered: true };
        saveProgress(deps.state, progress);
        return true;
      }
      try {
        if (closing || settlingTasks.has(data.task_id)) return false;
        await id.a2aReply(data.task_id, {
          intent: "progress",
          text: progress.acknowledgementText,
        });
      } catch (error) {
        deps.logger.warn("a2a.acknowledgement_failed", {
          taskId: data.task_id,
          error: String(error),
        });
        return false;
      }
      saveProgress(deps.state, {
        ...progress,
        active: closing || settlingTasks.has(data.task_id) ? false : progress.active,
        acknowledgementDelivered: true,
      });
      return true;
    });
  }

  async function waitForRuntime(runtime: ProgressRuntime, dueAt: number): Promise<void> {
    if (runtime.stopping || closing) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, dueAt - Date.now()));
      timer.unref?.();
      runtime.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    runtime.wake = undefined;
  }

  async function emitProgress(taskId: string): Promise<boolean> {
    return serializeTask(taskId, async () => {
      let progress = progressRegistry(deps.state)[taskId];
      if (!progress?.active || closing || latestTaskEntry(deps.state, taskId)?.replyIntentFenced) {
        return false;
      }
      const runtime = progressRuntimes.get(taskId);
      if (runtime?.stopping) return false;
      const id = await identity();
      let task = await id.a2aTask(taskId);
      if (TURN_STOPPED.has(normalizedState(task.state))) {
        saveProgress(deps.state, { ...progress, active: false });
        return false;
      }

      let text = progress.pendingText;
      if (text && workerTexts(task).includes(text)) {
        const now = Date.now();
        saveProgress(deps.state, {
          ...progress,
          pendingText: undefined,
          lastDeliveredText: text,
          deliveredCount: progress.deliveredCount + 1,
          nextDueAt: advanceDue(progress.nextDueAt, now, intervalMs),
        });
        return true;
      }
      if (!text) {
        const chatKey = `a2a:${id.id}:${progress.contextId}`;
        const summary = deps.sessions.summarizeA2AProgress
          ? await deps.sessions.summarizeA2AProgress(
              chatKey,
              taskId,
              progress.lastDeliveredText ?? "",
            )
          : "I'm continuing the requested work.";
        const elapsed = Math.max(1, Math.round((Date.now() - progress.startedAt) / 1000));
        text = `${summary} (${elapsed}s elapsed)`;
        progress = { ...progress, pendingText: text };
        saveProgress(deps.state, progress);
      }
      if (progressRuntimes.get(taskId)?.stopping || closing) return false;
      task = await id.a2aTask(taskId);
      if (TURN_STOPPED.has(normalizedState(task.state))) {
        saveProgress(deps.state, { ...progress, active: false });
        return false;
      }
      await id.a2aReply(taskId, { intent: "progress", text });
      const now = Date.now();
      saveProgress(deps.state, {
        ...progress,
        pendingText: undefined,
        lastDeliveredText: text,
        deliveredCount: progress.deliveredCount + 1,
        nextDueAt: advanceDue(progress.nextDueAt, now, intervalMs),
      });
      return true;
    });
  }

  async function progressLoop(taskId: string, runtime: ProgressRuntime): Promise<void> {
    while (!runtime.stopping && !closing) {
      const progress = progressRegistry(deps.state)[taskId];
      if (!progress?.active || intervalSeconds <= 0) return;
      await waitForRuntime(runtime, progress.pendingText ? Date.now() : progress.nextDueAt);
      if (runtime.stopping || closing) return;
      try {
        if (!(await emitProgress(taskId))) return;
      } catch (error) {
        deps.logger.warn("a2a.progress_failed", { taskId, error: String(error) });
        await waitForRuntime(runtime, Date.now() + RETRY_MS);
      }
    }
  }

  async function synchronizeProgressDrain(taskId: string, runtime: ProgressRuntime): Promise<void> {
    if (runtime.coordinating || closing) return;
    runtime.coordinating = true;
    try {
      if (latestTaskEntry(deps.state, taskId)?.replyIntentFenced) {
        runtime.stopping = true;
        runtime.wake?.();
        await runtime.loop;
        const requests = listA2AProgressDrains(taskId);
        if (!runtime.coordinatedTokens) runtime.coordinatedTokens = new Set<string>();
        for (const request of requests) {
          runtime.coordinatedTokens.add(request.token);
          acknowledgeA2AProgressDrain(taskId, request.token);
        }
        return;
      }
      let requests = listA2AProgressDrains(taskId);
      const stale = requests.filter(
        (request) => Date.now() - request.heartbeatAt >= DRAIN_STALE_MS,
      );
      if (stale.length > 0) {
        const id = await identity();
        const task = await id.a2aTask(taskId);
        if (TURN_STOPPED.has(normalizedState(task.state))) {
          await settleProgress(taskId);
          return;
        }
        const current = new Map(
          listA2AProgressDrains(taskId).map((request) => [request.token, request]),
        );
        if (!runtime.staleObservations) runtime.staleObservations = new Map();
        const observations = runtime.staleObservations;
        for (const request of stale) {
          const latest = current.get(request.token);
          if (!latest || Date.now() - latest.heartbeatAt < DRAIN_STALE_MS) {
            observations.delete(request.token);
            continue;
          }
          const previous = observations.get(request.token);
          if (
            previous?.heartbeatAt === latest.heartbeatAt &&
            Date.now() - previous.observedAt >= 1_000
          ) {
            clearA2AProgressDrain(taskId, request.token);
            observations.delete(request.token);
          } else if (previous?.heartbeatAt !== latest.heartbeatAt) {
            observations.set(request.token, {
              heartbeatAt: latest.heartbeatAt,
              observedAt: Date.now(),
            });
          }
        }
        requests = listA2AProgressDrains(taskId);
      }
      if (requests.length === 0) {
        if (runtime.coordinatedTokens?.size) {
          runtime.coordinatedTokens.clear();
          runtime.stopping = false;
          ensureProgressSupervisor(taskId);
        }
        return;
      }
      if (!runtime.coordinatedTokens) runtime.coordinatedTokens = new Set<string>();
      const coordinated = runtime.coordinatedTokens;
      const pending = requests.filter((request) => !coordinated.has(request.token));
      if (pending.length === 0) return;
      runtime.stopping = true;
      runtime.wake?.();
      await runtime.loop;
      for (const request of pending) {
        coordinated.add(request.token);
        acknowledgeA2AProgressDrain(taskId, request.token);
      }
    } catch (error) {
      deps.logger.warn("a2a.progress_drain_reconcile_failed", {
        taskId,
        error: String(error),
      });
    } finally {
      runtime.coordinating = false;
    }
  }

  function ensureProgressSupervisor(taskId: string): void {
    const progress = progressRegistry(deps.state)[taskId];
    if (closing || !progress?.active || latestTaskEntry(deps.state, taskId)?.replyIntentFenced)
      return;
    let runtime = progressRuntimes.get(taskId);
    if (!runtime) {
      runtime = { stopping: listA2AProgressDrains(taskId).length > 0 };
      progressRuntimes.set(taskId, runtime);
    }
    if (listA2AProgressDrains(taskId).length === 0) runtime.stopping = false;
    runtime.unregister ??= registerA2AProgressDrain(taskId, {
      drain: () => drainProgress(taskId),
      resume: () => ensureProgressSupervisor(taskId),
    });
    const monitored = runtime;
    if (!monitored.monitor) {
      monitored.monitor = setInterval(() => {
        void synchronizeProgressDrain(taskId, monitored);
      }, 50);
    }
    monitored.monitor.unref?.();
    void synchronizeProgressDrain(taskId, runtime);
    if (intervalSeconds > 0 && !runtime.stopping && !runtime.loop) {
      const supervisor = runtime;
      supervisor.loop = progressLoop(taskId, supervisor).finally(() => {
        supervisor.loop = undefined;
        if (!progressRegistry(deps.state)[taskId]?.active) {
          supervisor.unregister?.();
          if (supervisor.monitor) clearInterval(supervisor.monitor);
          progressRuntimes.delete(taskId);
        }
      });
    }
  }

  async function drainProgress(taskId: string): Promise<void> {
    const runtime = progressRuntimes.get(taskId);
    if (!runtime) return;
    runtime.stopping = true;
    runtime.wake?.();
    await runtime.loop;
  }

  async function settleProgress(taskId: string): Promise<void> {
    settlingTasks.add(taskId);
    await drainProgress(taskId);
    await serializeTask(taskId, async () => {
      const progress = progressRegistry(deps.state)[taskId];
      if (progress?.active) saveProgress(deps.state, { ...progress, active: false });
    });
    const runtime = progressRuntimes.get(taskId);
    runtime?.unregister?.();
    if (runtime?.monitor) clearInterval(runtime.monitor);
    progressRuntimes.delete(taskId);
    clearA2AProgressDrain(taskId);
  }

  async function runTurn(
    key: string,
    data: A2AEventData,
    initialAcknowledgementDelayMs: number,
  ): Promise<void> {
    const id = await identity();
    const taskId = data.task_id;
    if (initialAcknowledgementDelayMs > 0) {
      await waitForRetry(taskId, initialAcknowledgementDelayMs);
    }
    while (!closing) {
      try {
        if (await ensureAcknowledgement(data)) break;
      } catch (error) {
        deps.logger.warn("a2a.acknowledgement_retry_failed", {
          taskId,
          error: String(error),
        });
      }
      if (settlingTasks.has(taskId)) return;
      try {
        const task = await id.a2aTask(taskId);
        if (TURN_STOPPED.has(normalizedState(task.state))) {
          await settleProgress(taskId);
          persist(deps.state, key, data, "finalized");
          return;
        }
      } catch (error) {
        deps.logger.warn("a2a.task_state_retry_failed", { taskId, error: String(error) });
      }
      await waitForRetry(taskId, RETRY_MS);
    }
    if (closing) return;
    ensureProgressSupervisor(taskId);
    const chatKey = `a2a:${id.id}:${data.context_id}`;
    const context: ActiveA2ATurn = {
      taskId,
      contextId: data.context_id,
      messageId: data.message_id ?? "",
      replyIntentCommitted: false,
      registryKey: key,
      registryFilePath: deps.state.filePath,
      beforeReplyIntent: async () => {
        fenceReplyIntent(deps.state, key);
      },
    };
    const caller = data.caller ?? {};
    const body = (data.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    const marker =
      `[inkbox:a2a_task caller=@${String(caller.handle ?? "unknown").replace(/^@/, "")} ` +
      `caller_org=${caller.organization_id ?? "unknown"}]`;
    persist(deps.state, key, data, "running");
    try {
      const reply = await deps.sessions.runA2A(
        chatKey,
        `${marker}\n${INBOUND_TASK_DIRECTIVE}\n${body}`.trim(),
        context,
      );
      if (closing || settlingTasks.has(taskId)) return;
      if (
        !context.replyIntentCommitted &&
        reply?.trim() &&
        reply.trim().toUpperCase() !== "[SILENT]"
      ) {
        await context.beforeReplyIntent?.();
        const coordinationToken = requestA2AProgressDrain(taskId);
        let terminalAttempted = false;
        let heartbeat: NodeJS.Timeout | undefined;
        await drainProgress(taskId);
        acknowledgeA2AProgressDrain(taskId, coordinationToken);
        try {
          heartbeat = setInterval(() => renewA2AProgressDrain(taskId, coordinationToken), 1_000);
          heartbeat.unref?.();
          const task = await id.a2aTask(taskId);
          if (!TURN_STOPPED.has(normalizedState(task.state))) {
            terminalAttempted = true;
            await id.a2aReply(taskId, { intent: "complete", text: reply });
          }
        } catch (error) {
          if (!terminalAttempted) clearA2AProgressDrain(taskId, coordinationToken);
          throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          if (!terminalAttempted) clearA2AProgressDrain(taskId, coordinationToken);
        }
      }
      persist(deps.state, key, data, "finalized");
      const task = await id.a2aTask(taskId);
      if (TURN_STOPPED.has(normalizedState(task.state))) await settleProgress(taskId);
    } catch (error) {
      deps.logger.error("a2a.turn_failed", { taskId, error: String(error) });
    }
  }

  async function run(
    key: string,
    data: A2AEventData,
    initialAcknowledgementDelayMs: number,
  ): Promise<void> {
    try {
      await runTurn(key, data, initialAcknowledgementDelayMs);
    } catch (error) {
      deps.logger.error("a2a.turn_failed", { taskId: data.task_id, error: String(error) });
    }
  }

  function start(key: string, data: A2AEventData, acknowledgementDelayMs = 0): void {
    if (closing || settlingTasks.has(data.task_id) || running.has(key)) return;
    let active!: RunningJob;
    const task = run(key, data, acknowledgementDelayMs).finally(() => {
      if (running.get(key) === active) running.delete(key);
    });
    active = { key, taskId: data.task_id, contextId: data.context_id, task };
    running.set(key, active);
  }

  return {
    handles(event) {
      return event.provider === "inkbox" && event.eventType?.startsWith("a2a.") === true;
    },

    async handle(event) {
      const type = event.eventType ?? "";
      const data = eventData(event);
      if (!data) return true;
      if (type === "a2a.sent_task.updated") {
        const state = normalizedState(data.state);
        if (!REQUESTER_WAKE_STATES.has(state)) {
          deps.logger.info("a2a.sent_task_progress_observed", { taskId: data.task_id, state });
          return true;
        }
        const delegation = findDelegationByTask(data.task_id);
        const chatKey = delegation?.sessionId
          ? Object.entries(deps.state.read().sessions).find(
              ([, sessionId]) => sessionId === delegation.sessionId,
            )?.[0]
          : undefined;
        if (chatKey) {
          const text = (data.parts ?? [])
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n");
          await deps.sessions.runCapture(
            chatKey,
            `[inkbox:a2a_sent_task_updated task_id=${data.task_id} ` +
              `context_id=${data.context_id} state=${data.state ?? "unknown"}]\n` +
              "An A2A task you delegated changed state. Use " +
              "inkbox_a2a_check or inkbox_a2a_reply with the stored Agent Card " +
              `URL ${delegation?.cardUrl ?? "unknown"} if follow-up is needed.` +
              (text ? `\n\nRemote agent message:\n${text}` : ""),
          );
        } else {
          deps.logger.info("a2a.sent_task_updated_without_session", {
            taskId: data.task_id,
          });
        }
        return true;
      }
      if (type === "a2a.task.canceled") {
        const jobs = [...running.values()].filter(
          (job) => job.taskId === data.task_id && job.contextId === data.context_id,
        );
        wakeRetryWaiters(data.task_id);
        await settleProgress(data.task_id);
        const id = await identity();
        await deps.sessions.abortA2A(`a2a:${id.id}:${data.context_id}`, data.task_id);
        await Promise.allSettled(jobs.map((job) => job.task));
        return true;
      }
      const messageId = data.message_id ?? event.body.id?.toString() ?? "";
      const key = `${data.task_id}:${messageId}`;
      const normalized = { ...data, message_id: messageId };
      const existing = registry(deps.state)[key];
      if (existing) {
        if (existing.state !== "finalized" && !existing.replyIntentFenced) {
          const acknowledged = progressRegistry(deps.state)[data.task_id]?.acknowledgementDelivered;
          start(key, existing.data, acknowledged ? 0 : RETRY_MS);
        }
        return true;
      }
      persist(deps.state, key, normalized, "queued");
      ensureProgressRecord(normalized);
      let acknowledged = false;
      try {
        acknowledged = await ensureAcknowledgement(normalized);
      } catch (error) {
        deps.logger.warn("a2a.acknowledgement_attempt_failed", {
          taskId: data.task_id,
          error: String(error),
        });
      }
      start(key, normalized, acknowledged ? 0 : RETRY_MS);
      return true;
    },

    async catchUp() {
      const id = await identity();
      if (
        typeof id.a2aTask !== "function" ||
        typeof id.iterA2ATasks !== "function" ||
        typeof id.a2aReply !== "function"
      ) {
        deps.logger.warn("a2a.sdk_upgrade_required", {
          requiredVersion: "0.5.9",
        });
        return;
      }
      const persistedEntries = Object.entries(registry(deps.state)).sort(
        ([, left], [, right]) => right.updatedAt - left.updatedAt,
      );
      const resumedTaskIds = new Set<string>();
      for (const [key, entry] of persistedEntries) {
        if (entry.state === "finalized") continue;
        if (entry.replyIntentFenced) {
          resumedTaskIds.add(entry.taskId);
          await settleProgress(entry.taskId);
          continue;
        }
        try {
          const task = await id.a2aTask(entry.taskId);
          if (TURN_STOPPED.has(normalizedState(task.state))) {
            persist(deps.state, key, entry.data, "finalized");
            await settleProgress(entry.taskId);
          } else if (!resumedTaskIds.has(entry.taskId)) {
            resumedTaskIds.add(entry.taskId);
            ensureProgressRecord(entry.data);
            let acknowledged = false;
            try {
              acknowledged = await ensureAcknowledgement(entry.data);
            } catch (error) {
              deps.logger.warn("a2a.acknowledgement_attempt_failed", {
                taskId: entry.taskId,
                error: String(error),
              });
            }
            ensureProgressSupervisor(entry.taskId);
            start(key, entry.data, acknowledged ? 0 : RETRY_MS);
          } else {
            persist(deps.state, key, entry.data, "finalized");
          }
        } catch (error) {
          deps.logger.warn("a2a.registry_reconcile_failed", {
            taskId: entry.taskId,
            error: String(error),
          });
        }
      }
      try {
        for await (const task of id.iterA2ATasks({ state: "submitted" })) {
          const message = [...task.messages].reverse().find((candidate) => {
            const role = normalizedState(candidate?.role);
            return role === "caller" || role === "role_caller";
          });
          if (!message) continue;
          const data: A2AEventData = {
            task_id: String(task.id),
            context_id: String(task.contextId),
            state: normalizedState(task.state),
            caller: {
              identity_id: String(task.caller.identityId),
              organization_id: task.caller.organizationId,
              handle: task.caller.handle,
            },
            message_id: message?.messageId ?? `task:${task.id}`,
            parts: message?.parts ?? [],
          };
          const key = `${data.task_id}:${data.message_id}`;
          if (registry(deps.state)[key]) continue;
          persist(deps.state, key, data, "queued");
          ensureProgressRecord(data);
          let acknowledged = false;
          try {
            acknowledged = await ensureAcknowledgement(data);
          } catch (error) {
            deps.logger.warn("a2a.acknowledgement_attempt_failed", {
              taskId: data.task_id,
              error: String(error),
            });
          }
          ensureProgressSupervisor(data.task_id);
          start(key, data, acknowledged ? 0 : RETRY_MS);
        }
      } catch (error) {
        if (!isA2AApiUnavailable(error)) throw error;
        deps.logger.warn("a2a.api_unavailable", {
          error: String(error),
        });
      }
    },

    async close() {
      closing = true;
      wakeRetryWaiters();
      const jobs = [...running.values()];
      try {
        const id = await identity();
        await Promise.allSettled(
          jobs.map((job) => deps.sessions.abortA2A(`a2a:${id.id}:${job.contextId}`, job.taskId)),
        );
      } catch (error) {
        deps.logger.warn("a2a.shutdown_abort_failed", { error: String(error) });
      }
      const drains = [...progressRuntimes.keys()].map((taskId) => drainProgress(taskId));
      await Promise.allSettled(drains);
      await Promise.allSettled([...taskLocks.values()]);
      await Promise.allSettled(jobs.map((job) => job.task));
      for (const runtime of progressRuntimes.values()) {
        runtime.unregister?.();
        if (runtime.monitor) clearInterval(runtime.monitor);
      }
      progressRuntimes.clear();
    },
  };
}
