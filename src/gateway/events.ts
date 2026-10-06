import type { OpencodeClient } from "@opencode-ai/sdk";
import type { createEscalationBridge, PendingPermission } from "./escalation.js";
import type { GatewayLogger } from "./types.js";

// Current native hosts emit permission.asked on the raw SSE endpoint even
// when the consuming SDK describes the older permission.updated shape.
export function subscribePermissionEvents(
  opencode: OpencodeClient,
  escalation: ReturnType<typeof createEscalationBridge>,
  logger: GatewayLogger,
  directory: string,
): { close(): void } {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const stream = await opencode.event.subscribe({
          query: { directory },
          signal: controller.signal,
        });
        void escalation
          .reconcile?.(true)
          .catch(() => logger.warn("events.permission_inventory_failed", {}));
        for await (const evt of iterate(stream)) {
          if (controller.signal.aborted) break;
          const payload = (evt as any)?.payload ?? evt;
          const p = payload?.properties;
          if (!p || typeof p !== "object") continue;
          if (payload?.type === "permission.replied") {
            const id = p.requestID ?? p.id ?? p.permissionID;
            if (typeof id === "string" && id) escalation.resolved(id);
          }
          if (payload?.type === "permission.asked" || payload?.type === "permission.updated") {
            const permission = normalizePermission(p);
            if (!permission) continue;
            void escalation
              .handlePermission(permission)
              .catch((err) => logger.warn("events.permission_failed", { error: String(err) }));
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) logger.warn("events.stream_ended", { error: String(err) });
      }
      if (!controller.signal.aborted)
        await new Promise<void>((resolve) => {
          wake = resolve;
          retry = setTimeout(resolve, 1000);
        });
    }
  })();
  return {
    close() {
      controller.abort();
      if (retry) clearTimeout(retry);
      wake?.();
    },
  };
}

export function normalizePermission(value: unknown): PendingPermission | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, any>;
  if (typeof p.id !== "string" || !p.id || typeof p.sessionID !== "string" || !p.sessionID)
    return undefined;
  return {
    permissionID: p.id,
    sessionID: p.sessionID,
    title: permissionTitle(p),
    ...(typeof p.tool?.messageID === "string" && p.tool.messageID
      ? { toolMessageID: p.tool.messageID }
      : {}),
  };
}

async function* iterate(stream: unknown): AsyncGenerator<unknown> {
  const s = stream as any;
  const source = s?.stream ?? s?.data ?? s;
  if (source && typeof source[Symbol.asyncIterator] === "function") {
    yield* source as AsyncIterable<unknown>;
  }
}

function permissionTitle(request: {
  title?: unknown;
  permission?: unknown;
  patterns?: unknown;
}): string {
  let title = "Native tool permission";
  let omitted = "";
  if (typeof request.title === "string" && request.title) title = request.title;
  else if (typeof request.permission === "string" && request.permission) {
    const patterns = Array.isArray(request.patterns)
      ? request.patterns.filter((pattern): pattern is string => typeof pattern === "string")
      : [];
    const remaining = Math.max(0, patterns.length - 8);
    title = `${request.permission}${patterns.length ? `: ${patterns.slice(0, 8).join(", ")}` : ""}`;
    if (remaining)
      omitted = ` [${remaining} additional pattern${remaining === 1 ? "" : "s"} not shown]`;
  }
  const marker = "… [truncated]";
  if (title.length + omitted.length > 1000)
    return title.slice(0, 1000 - omitted.length - marker.length) + marker + omitted;
  return title + omitted;
}
