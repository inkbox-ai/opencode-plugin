import type { ActiveA2ATurn } from "../a2a-context.js";
import { findDelegationByTask } from "../a2a-delegations.js";
import type { InkboxRuntime } from "../client.js";
import type { StateStore } from "./state.js";
import type { GatewayLogger, SessionManager, VerifiedEvent } from "./types.js";

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

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
  updatedAt: number;
}

export interface A2AHandler {
  handles(event: VerifiedEvent): boolean;
  handle(event: VerifiedEvent): Promise<boolean>;
  catchUp(): Promise<void>;
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

function persist(
  state: StateStore,
  key: string,
  data: A2AEventData,
  status: RegistryEntry["state"],
): void {
  state.update({
    a2aTasks: {
      ...registry(state),
      [key]: {
        taskId: data.task_id,
        contextId: data.context_id,
        messageId: data.message_id ?? "",
        state: status,
        data,
        updatedAt: Date.now(),
      },
    },
  });
}

export function createA2AHandler(deps: {
  inkbox: InkboxRuntime;
  sessions: SessionManager;
  state: StateStore;
  logger: GatewayLogger;
}): A2AHandler {
  const running = new Map<string, Set<Promise<void>>>();

  async function identity(): Promise<any> {
    return deps.inkbox.getIdentity() as Promise<any>;
  }

  async function run(key: string, data: A2AEventData): Promise<void> {
    const id = await identity();
    const taskId = data.task_id;
    const chatKey = `a2a:${id.id}:${data.context_id}`;
    const context: ActiveA2ATurn = {
      taskId,
      contextId: data.context_id,
      messageId: data.message_id ?? "",
      replyIntentCommitted: false,
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
      const reply = await deps.sessions.runA2A(chatKey, `${marker}\n${body}`.trim(), context);
      if (
        !context.replyIntentCommitted &&
        reply?.trim() &&
        reply.trim().toUpperCase() !== "[SILENT]"
      ) {
        const task = await id.a2aTask(taskId);
        if (!TERMINAL.has(String(task.state))) {
          await id.a2aReply(taskId, { intent: "complete", text: reply });
        }
      }
      persist(deps.state, key, data, "finalized");
    } catch (error) {
      deps.logger.error("a2a.turn_failed", { taskId, error: String(error) });
    }
  }

  function start(key: string, data: A2AEventData): void {
    const job = run(key, data);
    const jobs = running.get(data.task_id) ?? new Set<Promise<void>>();
    jobs.add(job);
    running.set(data.task_id, jobs);
    void job.finally(() => {
      jobs.delete(job);
      if (jobs.size === 0) running.delete(data.task_id);
    });
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
        const id = await identity();
        await deps.sessions.abortA2A(`a2a:${id.id}:${data.context_id}`, data.task_id);
        return true;
      }
      const messageId = data.message_id ?? event.body.id?.toString() ?? "";
      const key = `${data.task_id}:${messageId}`;
      if (registry(deps.state)[key]) return true;
      const normalized = { ...data, message_id: messageId };
      persist(deps.state, key, normalized, "queued");
      start(key, normalized);
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
          requiredVersion: "0.5.5",
        });
        return;
      }
      for (const [key, entry] of Object.entries(registry(deps.state))) {
        if (entry.state === "finalized") continue;
        try {
          const task = await id.a2aTask(entry.taskId);
          if (TERMINAL.has(String(task.state))) {
            persist(deps.state, key, entry.data, "finalized");
          } else {
            start(key, entry.data);
          }
        } catch (error) {
          deps.logger.warn("a2a.registry_reconcile_failed", {
            taskId: entry.taskId,
            error: String(error),
          });
        }
      }
      for await (const task of id.iterA2ATasks({ state: "submitted" })) {
        const message = task.messages.at(-1);
        const data: A2AEventData = {
          task_id: String(task.id),
          context_id: String(task.contextId),
          state: String(task.state),
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
        start(key, data);
      }
    },
  };
}
