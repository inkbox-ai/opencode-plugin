import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DurablePermission, StateStore } from "./state.js";
import type { GatewayLogger, ReplyTarget } from "./types.js";

// A permission request raised inside a gateway session, waiting on a human.
export interface PendingPermission {
  permissionID: string;
  sessionID: string;
  title: string;
  // The chatKey (human) this session belongs to, filled in by the caller.
  chatKey?: string;
  toolMessageID?: string;
}

export interface PermissionOwner {
  turnId: string;
  ownerId: string;
  messageID: string;
  toolMessageID: string;
  sessionID: string;
  chatKey: string;
  replyTarget?: ReplyTarget;
}

export interface EscalationRelay {
  // Ask the human on their channel; returns their raw reply text, or
  // undefined on timeout. The relay owns delivery + capturing the reply.
  ask(
    chatKey: string,
    prompt: string,
    target?: ReplyTarget,
    options?: { signal: AbortSignal; timeoutMs: number; current?: () => boolean },
  ): Promise<string | undefined>;
}

export interface EscalationDeps {
  opencode: OpencodeClient;
  logger: GatewayLogger;
  relay: EscalationRelay;
  // chatKey for a session id (from the session manager's mapping).
  chatKeyForSession(sessionID: string): string | undefined;
  timeoutMs: number;
  // Project directory the gateway sessions live in; permission responses must
  // target the same instance the session was created against.
  directory: string;
  state: StateStore;
  resolveOwner?(
    permission: PendingPermission,
    signal: AbortSignal,
  ): Promise<PermissionOwner | undefined>;
  ownerCurrent?(owner: PermissionOwner): boolean;
  inventory?(): Promise<PendingPermission[]>;
}

// Map a human's free-text reply to a permission response. Accepts the
// numbered menu (1/2/3) and common words; anything else is treated as a
// decline so a confused reply never approves an action.
export function parsePermissionReply(raw: string): "once" | "always" | "reject" {
  const v = (raw ?? "").trim().toLowerCase();
  if (["2", "always", "allow always", "yes always"].includes(v)) return "always";
  if (
    [
      "1",
      "y",
      "yes",
      "yes please go ahead",
      "ok",
      "okay",
      "approve",
      "allow",
      "sure",
      "go",
      "go ahead",
    ].includes(v)
  ) {
    return "once";
  }
  return "reject";
}

function menu(title: string): string {
  return (
    `Permission needed: ${title}\n\n` +
    "Reply 1 to allow once, 2 to always allow (this conversation), or 3 to decline."
  );
}

// Bridges opencode permission requests in gateway sessions to the human on
// their channel: relay the ask, capture the reply, respond via the server
// API. Works identically from the sidecar and in-plugin (pure server API).
export function createEscalationBridge(deps: EscalationDeps) {
  const inFlight = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const resolved = new Set<string>();
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let closeSignal: AbortSignal | undefined;
  const admitting = new Set<Promise<unknown>>();
  const retirements = new Map<string, Promise<void>>();
  const failures: unknown[] = [];
  let inventoryTask: Promise<void> | undefined;
  let inventoryAt = 0;
  let inventoryRetry: ReturnType<typeof setTimeout> | undefined;

  function inventoryReady(ready: boolean): void {
    if ((deps.state.read().permissionInventory as { ready?: boolean } | undefined)?.ready !== ready)
      deps.state.update({ permissionInventory: { ready } });
  }

  function cancelInventoryRetry(): void {
    if (inventoryRetry) clearTimeout(inventoryRetry);
    inventoryRetry = undefined;
  }

  function retryInventory(): void {
    if (closed || !deps.inventory || inventoryRetry) return;
    inventoryRetry = setTimeout(() => {
      inventoryRetry = undefined;
      void reconcile(true).catch(() => deps.logger.warn("escalation.inventory_retry_failed", {}));
    }, 5000);
    inventoryRetry.unref?.();
  }

  function handlePermission(perm: PendingPermission, recovering = false): Promise<void> {
    let accept: () => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const admission = new Promise<void>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    admitting.add(admission);
    void admission.catch(() => {}).finally(() => admitting.delete(admission));
    const task = admitPermission(perm, recovering, accept);
    void task.then(accept, (error) => {
      reject(error);
      if (closed) failures.push(error);
    });
    return task;
  }

  function current(record: DurablePermission): boolean {
    return record.owner && deps.ownerCurrent
      ? deps.ownerCurrent({
          ...record.owner,
          sessionID: record.sessionID,
          chatKey: record.chatKey,
          replyTarget: record.replyTarget,
        })
      : deps.chatKeyForSession(record.sessionID) === record.chatKey;
  }

  function retire(record: DurablePermission): Promise<void> {
    const running = retirements.get(record.permissionID);
    if (running) return running;
    const task = (async () => {
      const latest = deps.state
        .listPermissions()
        .find((p) => p.permissionID === record.permissionID);
      if (
        !latest ||
        resolved.has(record.permissionID) ||
        latest.state === "responding" ||
        !current(latest)
      )
        return;
      const signal = closeSignal ?? AbortSignal.timeout(5000);
      // A known pre-request deadline leaves a retryable pending record; never
      // mislabel a request which was not attempted as an uncertain response.
      signal.throwIfAborted();
      deps.state.savePermission({ ...latest, state: "responding", response: "reject" });
      const result = await deps.opencode.postSessionIdPermissionsPermissionId({
        path: { id: latest.sessionID, permissionID: latest.permissionID },
        query: { directory: deps.directory },
        body: { response: "reject" },
        signal,
      });
      if ((result as any)?.error || result.data !== true)
        throw new Error("Native permission shutdown rejection was not acknowledged.");
      deps.state.removePermission(latest.permissionID);
    })();
    retirements.set(record.permissionID, task);
    void task
      .catch((error) => {
        if (closed) failures.push(error);
      })
      .finally(() => retirements.delete(record.permissionID));
    return task;
  }

  async function admitPermission(
    perm: PendingPermission,
    recovering = false,
    admitted: () => void,
  ): Promise<void> {
    if (resolved.has(perm.permissionID) || inFlight.has(perm.permissionID)) return;
    const stored = deps.state.listPermissions().find((p) => p.permissionID === perm.permissionID);
    // A native response might already have taken effect. Inventory and shutdown
    // must not replay it or replace an approval with a conflicting rejection.
    if (stored?.state === "responding") return;
    let owner: PermissionOwner | undefined;
    if (deps.resolveOwner) {
      owner = await deps.resolveOwner(perm, closeSignal ?? AbortSignal.timeout(5000));
      if (!owner || !deps.ownerCurrent?.(owner)) return;
    }
    if (closed) {
      const chatKey = owner?.chatKey ?? deps.chatKeyForSession(perm.sessionID);
      if (!chatKey || resolved.has(perm.permissionID)) return;
      const existing = deps.state
        .listPermissions()
        .find((p) => p.permissionID === perm.permissionID);
      if (existing?.state === "responding") return;
      const record: DurablePermission = {
        ...existing,
        permissionID: perm.permissionID,
        sessionID: perm.sessionID,
        chatKey,
        title: perm.title,
        deadline: existing?.deadline ?? Date.now(),
        state: "pending",
        replyTarget: owner ? owner.replyTarget : existing?.replyTarget,
        ...(owner ? { owner } : {}),
      };
      deps.state.savePermission(record);
      admitted();
      await retire(record);
      return;
    }
    return runPermission(perm, recovering, owner, admitted);
  }

  async function runPermission(
    perm: PendingPermission,
    recovering = false,
    owner?: PermissionOwner,
    admitted: () => void = () => {},
  ): Promise<void> {
    const chatKey = owner?.chatKey ?? perm.chatKey ?? deps.chatKeyForSession(perm.sessionID);
    if (!chatKey) {
      // Not a gateway session we own — leave it for whoever does.
      return;
    }
    if (closed || resolved.has(perm.permissionID) || inFlight.has(perm.permissionID)) return;
    const existing = deps.state
      .listPermissions()
      .find((candidate) => candidate.permissionID === perm.permissionID);
    if (existing?.state === "responding") return;
    if (existing && !recovering) return;
    const origin = owner
      ? owner.replyTarget
      : (existing?.replyTarget ??
        deps.state
          .listTurns()
          .find(
            (turn) =>
              turn.sessionID === perm.sessionID && ["submitted", "submitting"].includes(turn.state),
          )?.replyTarget ??
        deps.state.getReplyTarget(chatKey));
    const deadline =
      existing?.deadline ??
      (deps.timeoutMs > 0 ? Date.now() + deps.timeoutMs : Number.MAX_SAFE_INTEGER);
    deps.state.savePermission({
      ...(owner ? { owner } : {}),
      replyTarget: origin,
      permissionID: perm.permissionID,
      sessionID: perm.sessionID,
      chatKey,
      title: perm.title,
      deadline,
      state: "pending",
    });
    inFlight.add(perm.permissionID);
    const controller = new AbortController();
    controllers.set(perm.permissionID, controller);
    let postStarted = false;
    try {
      const expired = deadline <= Date.now();
      const remaining = deps.timeoutMs > 0 ? Math.max(0, deadline - Date.now()) : 0;
      let response: DurablePermission["response"];
      if (!response) {
        deps.state.savePermission({
          ...(owner ? { owner } : {}),
          replyTarget: origin,
          permissionID: perm.permissionID,
          sessionID: perm.sessionID,
          chatKey,
          title: perm.title,
          deadline,
          state: "relayed",
        });
        admitted();
        const reply = expired
          ? undefined
          : await withTimeout(
              deps.relay.ask(chatKey, menu(perm.title), origin, {
                signal: controller.signal,
                timeoutMs: remaining,
                ...(owner ? { current: () => !closed && Boolean(deps.ownerCurrent?.(owner)) } : {}),
              }),
              remaining,
            );
        if (closed || resolved.has(perm.permissionID) || (owner && !deps.ownerCurrent?.(owner)))
          return;
        response = reply === undefined ? "reject" : parsePermissionReply(reply);
        if (reply === undefined) {
          deps.logger.info("escalation.timeout", { permissionID: perm.permissionID, chatKey });
        }
      }
      deps.state.savePermission({
        ...(owner ? { owner } : {}),
        replyTarget: origin,
        permissionID: perm.permissionID,
        sessionID: perm.sessionID,
        chatKey,
        title: perm.title,
        deadline,
        state: "responding",
        response,
      });
      if (owner && !deps.ownerCurrent?.(owner)) return;
      postStarted = true;
      const result = await deps.opencode.postSessionIdPermissionsPermissionId({
        path: { id: perm.sessionID, permissionID: perm.permissionID },
        query: { directory: deps.directory },
        body: { response },
      });
      if ((result as any)?.error) {
        const detail = JSON.stringify((result as any).error);
        if (/not.?found|404/i.test(detail)) {
          deps.state.removePermission(perm.permissionID);
          return;
        }
        throw new Error(detail);
      }
      if (owner && result.data !== true)
        throw new Error("Native permission response was not acknowledged.");
      deps.state.removePermission(perm.permissionID);
      deps.logger.info("escalation.resolved", { permissionID: perm.permissionID, response });
    } catch (err) {
      if (
        closed ||
        resolved.has(perm.permissionID) ||
        postStarted ||
        (owner && !deps.ownerCurrent?.(owner))
      )
        return;
      deps.logger.error("escalation.failed", {
        permissionID: perm.permissionID,
        error: String(err),
      });
      const record = deps.state.listPermissions().find((p) => p.permissionID === perm.permissionID);
      if (record) await retire(record);
    } finally {
      controller.abort();
      if (controllers.get(perm.permissionID) === controller) controllers.delete(perm.permissionID);
      inFlight.delete(perm.permissionID);
    }
  }

  async function drain(): Promise<void> {
    while (admitting.size || retirements.size) {
      const signal = closeSignal;
      if (!signal) throw new Error("Native permission shutdown has not started.");
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...admitting, ...retirements.values()]),
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error("Native permission shutdown deadline expired."));
            signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    }
    if (failures.length) throw failures[0];
  }

  function reconcile(force = false): Promise<void> {
    if (closed || !deps.inventory) return Promise.resolve();
    const inventory = deps.inventory;
    if (inventoryTask) return inventoryTask;
    if (!force && Date.now() - inventoryAt < 5000) return Promise.resolve();
    cancelInventoryRetry();
    inventoryAt = Date.now();
    inventoryTask = (async () => {
      try {
        const permissions = await inventory();
        if (closed) return;
        for (const permission of permissions) {
          if (
            deps.state
              .listPermissions()
              .some((p) => p.permissionID === permission.permissionID && p.state === "responding")
          )
            continue;
          void handlePermission(permission, true).catch(() => {
            if (!closed)
              try {
                inventoryReady(false);
              } catch {
                /* Retain the source; retry inventory after recovery. */
              }
            retryInventory();
            deps.logger.warn("escalation.inventory_admission_failed", {});
          });
        }
        // Only admission/native ownership reads, never the human relay.
        const checked = await Promise.allSettled([...admitting]);
        if (checked.some((item) => item.status === "rejected"))
          throw new Error("Native permission ownership read was not confirmed.");
        if (!closed) inventoryReady(true);
      } catch (error) {
        if (!closed)
          try {
            inventoryReady(false);
          } catch {
            /* Do not replace the original failure. */
          }
        retryInventory();
        throw error;
      }
    })().finally(() => {
      inventoryTask = undefined;
    });
    return inventoryTask;
  }

  return {
    handlePermission,
    resolved(permissionID: string) {
      resolved.add(permissionID);
      controllers.get(permissionID)?.abort();
      deps.state.removePermission(permissionID);
    },
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closed = true;
      cancelInventoryRetry();
      closeSignal = AbortSignal.timeout(5000);
      const owned = [...controllers.entries()];
      for (const [, controller] of owned) controller.abort();
      for (const [permissionID] of owned) {
        const current = deps.state
          .listPermissions()
          .find((entry) => entry.permissionID === permissionID);
        if (current) void retire(current).catch(() => {});
      }
      closeTask = drain();
      return closeTask;
    },
    // Call after the SSE reader is detached. Admissions already in progress
    // remain tracked; accepted host turns themselves are deliberately retained.
    detach: drain,
    reconcile,
    isInFlight: (permissionID: string) => inFlight.has(permissionID),
    async catchUp() {
      await Promise.all(
        deps.state.listPermissions().map((permission) =>
          handlePermission(
            {
              permissionID: permission.permissionID,
              sessionID: permission.sessionID,
              title: permission.title,
              chatKey: permission.chatKey,
            },
            true,
          ),
        ),
      );
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
