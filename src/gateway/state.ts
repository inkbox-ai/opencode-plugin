import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActiveA2ATurn } from "../a2a-context.js";
import type { ReplyTarget, TurnKind } from "./types.js";

export interface DurableHostedCapture {
  identityId: string;
  callId: string;
  phase: "initial" | "correction";
  expectedTarget: string;
}

export type DurableTurnState =
  | "queued"
  | "submitting"
  | "submitted"
  | "completed"
  | "delivery_started"
  | "delivered"
  | "failed"
  | "interrupted";

export interface DurableTurn {
  id: string;
  messageID: string;
  chatKey: string;
  sessionID?: string;
  state: DurableTurnState;
  kind: TurnKind;
  text: string;
  deliver: boolean;
  agent?: string;
  replyTarget?: ReplyTarget;
  a2aContext?: ActiveA2ATurn;
  hostedCapture?: DurableHostedCapture;
  output?: string;
  deliveryMessageId?: string;
  error?: string;
  ownerId?: string;
  leaseUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DurablePermission {
  permissionID: string;
  sessionID: string;
  chatKey: string;
  title: string;
  deadline: number;
  state: "pending" | "relayed" | "responding";
  response?: "once" | "always" | "reject";
}

// Persistent gateway state: the contact->session mapping (opencode persists
// the sessions themselves server-side; we persist which session belongs to
// which human), plus small operational records like the tunnel id.
export interface GatewayState {
  // chatKey -> opencode session id
  sessions: Record<string, string>;
  turns: Record<string, DurableTurn>;
  replyTargets: Record<string, ReplyTarget>;
  permissions: Record<string, DurablePermission>;
  tunnelId?: string;
  [key: string]: unknown;
}

export interface StateStore {
  read(): GatewayState;
  // Merge-and-write. Atomic (tmp file + rename) so a crash never leaves a
  // truncated state file.
  update(patch: Partial<GatewayState>): GatewayState;
  updateA2ATask(key: string, update: (entry: unknown) => unknown): void;
  setSession(chatKey: string, sessionID: string): void;
  getSession(chatKey: string): string | undefined;
  clearSession(chatKey: string): void;
  setReplyTarget(chatKey: string, target: ReplyTarget): void;
  getReplyTarget(chatKey: string): ReplyTarget | undefined;
  saveTurn(turn: DurableTurn): void;
  updateTurn(id: string, patch: Partial<DurableTurn>): DurableTurn | undefined;
  transitionTurn(
    id: string,
    expected: DurableTurnState[],
    patch: Partial<DurableTurn>,
  ): DurableTurn | undefined;
  getTurn(id: string): DurableTurn | undefined;
  listTurns(): DurableTurn[];
  claimTurn(id: string, ownerId: string, leaseMs: number): DurableTurn | undefined;
  savePermission(permission: DurablePermission): void;
  removePermission(permissionID: string): void;
  listPermissions(): DurablePermission[];
  readonly filePath: string;
}

export function gatewayHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INKBOX_OPENCODE_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".inkbox-opencode");
}

const EMPTY: GatewayState = { sessions: {}, turns: {}, replyTargets: {}, permissions: {} };

export function createStateStore(dir: string = gatewayHome()): StateStore {
  const filePath = path.join(dir, "state.json");

  function read(): GatewayState {
    let loaded: GatewayState;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      loaded = {
        ...EMPTY,
        ...raw,
        sessions: typeof raw.sessions === "object" && raw.sessions ? raw.sessions : {},
        turns: typeof raw.turns === "object" && raw.turns ? raw.turns : {},
        replyTargets:
          typeof raw.replyTargets === "object" && raw.replyTargets ? raw.replyTargets : {},
        permissions: typeof raw.permissions === "object" && raw.permissions ? raw.permissions : {},
      };
    } catch {
      loaded = { sessions: {}, turns: {}, replyTargets: {}, permissions: {} };
    }
    return loaded;
  }

  function write(next: GatewayState): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  function mutate<T>(change: (state: GatewayState) => [GatewayState, T]): T {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = `${filePath}.lock`;
    let handle: number | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        handle = fs.openSync(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.unlinkSync(lock);
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (handle === undefined) throw new Error("Gateway state is busy; retry this operation.");
    try {
      const [next, result] = change(read());
      write(next);
      return result;
    } finally {
      fs.closeSync(handle);
      try {
        fs.unlinkSync(lock);
      } catch {
        // A stale-lock recovery may already have removed it.
      }
    }
  }

  return {
    filePath,
    read,
    update(patch) {
      return mutate((state) => {
        const next = { ...state, ...patch };
        return [next, next];
      });
    },
    updateA2ATask(key, update) {
      mutate((state) => {
        const tasks =
          state.a2aTasks && typeof state.a2aTasks === "object"
            ? (state.a2aTasks as Record<string, unknown>)
            : {};
        const entry = update(tasks[key]);
        if (entry === undefined) return [state, undefined];
        return [{ ...state, a2aTasks: { ...tasks, [key]: entry } }, undefined];
      });
    },
    setSession(chatKey, sessionID) {
      mutate((state) => [
        { ...state, sessions: { ...state.sessions, [chatKey]: sessionID } },
        undefined,
      ]);
    },
    getSession(chatKey) {
      return read().sessions[chatKey];
    },
    clearSession(chatKey) {
      mutate((state) => {
        const sessions = { ...state.sessions };
        delete sessions[chatKey];
        return [{ ...state, sessions }, undefined];
      });
    },
    setReplyTarget(chatKey, target) {
      mutate((state) => [
        { ...state, replyTargets: { ...state.replyTargets, [chatKey]: target } },
        undefined,
      ]);
    },
    getReplyTarget(chatKey) {
      return read().replyTargets[chatKey];
    },
    saveTurn(turn) {
      mutate((state) => {
        const turns = { ...state.turns, [turn.id]: turn };
        const terminal = Object.values(turns)
          .filter(
            (candidate) =>
              !candidate.hostedCapture &&
              ["completed", "delivered", "failed", "interrupted"].includes(candidate.state),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
        for (const stale of terminal.slice(200)) delete turns[stale.id];
        return [{ ...state, turns }, undefined];
      });
    },
    updateTurn(id, patch) {
      return mutate((state) => {
        const current = state.turns[id];
        if (!current) return [state, undefined];
        const turn = { ...current, ...patch, updatedAt: Date.now() };
        return [{ ...state, turns: { ...state.turns, [id]: turn } }, turn];
      });
    },
    transitionTurn(id, expected, patch) {
      return mutate((state) => {
        const current = state.turns[id];
        if (!current || !expected.includes(current.state)) return [state, undefined];
        const turn = { ...current, ...patch, updatedAt: Date.now() };
        return [{ ...state, turns: { ...state.turns, [id]: turn } }, turn];
      });
    },
    getTurn(id) {
      return read().turns[id];
    },
    listTurns() {
      return Object.values(read().turns);
    },
    claimTurn(id, ownerId, leaseMs) {
      return mutate((state) => {
        const current = state.turns[id];
        if (!current) return [state, undefined];
        const conflictingChatOwner = Object.values(state.turns).some(
          (candidate) =>
            candidate.id !== id &&
            candidate.chatKey === current.chatKey &&
            ["queued", "submitting", "submitted", "delivery_started"].includes(candidate.state) &&
            Boolean(candidate.ownerId) &&
            candidate.ownerId !== ownerId &&
            (candidate.leaseUntil ?? 0) > Date.now(),
        );
        if (
          conflictingChatOwner ||
          (current.ownerId && current.ownerId !== ownerId && (current.leaseUntil ?? 0) > Date.now())
        ) {
          return [state, undefined];
        }
        const turn = {
          ...current,
          ownerId,
          leaseUntil: Date.now() + leaseMs,
          updatedAt: Date.now(),
        };
        return [{ ...state, turns: { ...state.turns, [id]: turn } }, turn];
      });
    },
    savePermission(permission) {
      mutate((state) => [
        {
          ...state,
          permissions: { ...state.permissions, [permission.permissionID]: permission },
        },
        undefined,
      ]);
    },
    removePermission(permissionID) {
      mutate((state) => {
        const permissions = { ...state.permissions };
        delete permissions[permissionID];
        return [{ ...state, permissions }, undefined];
      });
    },
    listPermissions() {
      return Object.values(read().permissions);
    },
  };
}
