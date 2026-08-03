import type { OpencodeClient } from "@opencode-ai/sdk";
import type { StateStore } from "./state.js";
import type { GatewayLogger } from "./types.js";

// A permission request raised inside a gateway session, waiting on a human.
export interface PendingPermission {
  permissionID: string;
  sessionID: string;
  title: string;
  // The chatKey (human) this session belongs to, filled in by the caller.
  chatKey?: string;
}

export interface EscalationRelay {
  // Ask the human on their channel; returns their raw reply text, or
  // undefined on timeout. The relay owns delivery + capturing the reply.
  ask(chatKey: string, prompt: string): Promise<string | undefined>;
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
}

// Map a human's free-text reply to a permission response. Accepts the
// numbered menu (1/2/3) and common words; anything else is treated as a
// decline so a confused reply never approves an action.
export function parsePermissionReply(raw: string): "once" | "always" | "reject" {
  const v = (raw ?? "").trim().toLowerCase();
  if (["2", "always", "allow always", "yes always"].includes(v)) return "always";
  if (["1", "y", "yes", "ok", "okay", "approve", "allow", "sure", "go", "go ahead"].includes(v)) {
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

  async function handlePermission(perm: PendingPermission, recovering = false): Promise<void> {
    const chatKey = perm.chatKey ?? deps.chatKeyForSession(perm.sessionID);
    if (!chatKey) {
      // Not a gateway session we own — leave it for whoever does.
      return;
    }
    if (inFlight.has(perm.permissionID)) return;
    const existing = deps.state
      .listPermissions()
      .find((candidate) => candidate.permissionID === perm.permissionID);
    if (existing && !recovering) return;
    const deadline =
      existing?.deadline ??
      (deps.timeoutMs > 0 ? Date.now() + deps.timeoutMs : Number.MAX_SAFE_INTEGER);
    deps.state.savePermission({
      permissionID: perm.permissionID,
      sessionID: perm.sessionID,
      chatKey,
      title: perm.title,
      deadline,
      state: "pending",
    });
    inFlight.add(perm.permissionID);
    try {
      const expired = deadline <= Date.now();
      const remaining = deps.timeoutMs > 0 ? Math.max(0, deadline - Date.now()) : 0;
      let response = existing?.state === "responding" ? existing.response : undefined;
      if (!response) {
        deps.state.savePermission({
          permissionID: perm.permissionID,
          sessionID: perm.sessionID,
          chatKey,
          title: perm.title,
          deadline,
          state: "relayed",
        });
        const reply = expired
          ? undefined
          : await withTimeout(deps.relay.ask(chatKey, menu(perm.title)), remaining);
        response = reply === undefined ? "reject" : parsePermissionReply(reply);
        if (reply === undefined) {
          deps.logger.info("escalation.timeout", { permissionID: perm.permissionID, chatKey });
        }
      }
      deps.state.savePermission({
        permissionID: perm.permissionID,
        sessionID: perm.sessionID,
        chatKey,
        title: perm.title,
        deadline,
        state: "responding",
        response,
      });
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
      deps.state.removePermission(perm.permissionID);
      deps.logger.info("escalation.resolved", { permissionID: perm.permissionID, response });
    } catch (err) {
      deps.logger.error("escalation.failed", {
        permissionID: perm.permissionID,
        error: String(err),
      });
      // Best-effort decline so a stuck ask never blocks the session forever.
      await deps.opencode
        .postSessionIdPermissionsPermissionId({
          path: { id: perm.sessionID, permissionID: perm.permissionID },
          query: { directory: deps.directory },
          body: { response: "reject" },
        })
        .catch(() => {});
    } finally {
      inFlight.delete(perm.permissionID);
    }
  }

  return {
    handlePermission,
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
