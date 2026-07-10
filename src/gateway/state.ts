import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Persistent gateway state: the contact->session mapping (opencode persists
// the sessions themselves server-side; we persist which session belongs to
// which human), plus small operational records like the tunnel id.
export interface GatewayState {
  // chatKey -> opencode session id
  sessions: Record<string, string>;
  tunnelId?: string;
  [key: string]: unknown;
}

export interface StateStore {
  read(): GatewayState;
  // Merge-and-write. Atomic (tmp file + rename) so a crash never leaves a
  // truncated state file.
  update(patch: Partial<GatewayState>): GatewayState;
  setSession(chatKey: string, sessionID: string): void;
  getSession(chatKey: string): string | undefined;
  clearSession(chatKey: string): void;
  readonly filePath: string;
}

export function gatewayHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INKBOX_OPENCODE_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".inkbox-opencode");
}

const EMPTY: GatewayState = { sessions: {} };

export function createStateStore(dir: string = gatewayHome()): StateStore {
  const filePath = path.join(dir, "state.json");
  let cache: GatewayState | undefined;

  function read(): GatewayState {
    if (cache) return cache;
    let loaded: GatewayState;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      loaded = {
        ...EMPTY,
        ...raw,
        sessions: typeof raw.sessions === "object" && raw.sessions ? raw.sessions : {},
      };
    } catch {
      loaded = { ...EMPTY, sessions: {} };
    }
    cache = loaded;
    return loaded;
  }

  function write(next: GatewayState): void {
    cache = next;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, filePath);
  }

  return {
    filePath,
    read,
    update(patch) {
      const next = { ...read(), ...patch };
      write(next);
      return next;
    },
    setSession(chatKey, sessionID) {
      const state = read();
      write({ ...state, sessions: { ...state.sessions, [chatKey]: sessionID } });
    },
    getSession(chatKey) {
      return read().sessions[chatKey];
    },
    clearSession(chatKey) {
      const state = read();
      const sessions = { ...state.sessions };
      delete sessions[chatKey];
      write({ ...state, sessions });
    },
  };
}
