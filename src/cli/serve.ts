import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { ResolvedConfig } from "../config.js";
import type { GatewayLogger } from "../gateway/types.js";

// opencode's default server bind: where an interactive `opencode serve` (or a
// CI harness) listens. The sidecar attaches here when nothing is configured,
// and launches its own managed server when nobody answers.
export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:4096";

// A cheap reachability probe against the opencode server. Any resolved
// response counts as reachable; a rejected fetch (server down) does not.
export async function opencodeReachable(opencode: OpencodeClient): Promise<boolean> {
  try {
    await opencode.config.get();
    return true;
  } catch {
    return false;
  }
}

// Resolve a bare binary name to something spawnable outside a login shell
// (systemd/launchd strip the nvm PATH): keep a pathy bin or a PATH hit as-is,
// else fall back to a sibling of the running node (`npm i -g` puts them
// together). Returns the input unchanged when nothing resolves.
export function resolveOpencodeBin(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): string {
  if (bin.includes(path.sep)) return bin;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (dirs.some((d) => fs.existsSync(path.join(d, bin)))) return bin;
  const sibling = path.join(path.dirname(execPath), bin);
  return fs.existsSync(sibling) ? sibling : bin;
}

// True when `bin` resolves to an existing file — directly, via PATH, or as a
// sibling of the running node. A doctor-level existence check only.
export function opencodeBinAvailable(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): boolean {
  const resolved = resolveOpencodeBin(bin, env, execPath);
  if (resolved.includes(path.sep)) return fs.existsSync(resolved);
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, resolved)));
}

// The slice of ChildProcess the manager needs; tests fake this.
export interface ServeChild {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: (code: number | null) => void): unknown;
  once(event: "error", cb: (err: Error) => void): unknown;
}

export type SpawnServe = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ServeChild;

export interface EnsuredServer {
  url: string;
  owned: boolean;
  // Fires when an owned server dies out from under the gateway. Never fires
  // for an attached server, nor during a deliberate stop().
  onExit(cb: (code: number | null) => void): void;
  stop(): Promise<void>;
}

export interface ServeDeps {
  probe?: (url: string) => Promise<boolean>;
  spawnServe?: SpawnServe;
  pollMs?: number;
  timeoutMs?: number;
}

// Serve logs are inherited so daemon/foreground logs carry them too.
const defaultSpawn: SpawnServe = (bin, args, opts) =>
  nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "inherit", "inherit"] });

const defaultProbe = (url: string) => opencodeReachable(createOpencodeClient({ baseUrl: url }));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Resolve the opencode server the gateway should use. An explicitly configured
// URL must answer; otherwise attach to a server already on the default port,
// else spawn and own `<bin> serve` (stopped on shutdown; its death is fatal).
export async function ensureOpencodeServer(
  config: ResolvedConfig,
  logger: GatewayLogger,
  deps: ServeDeps = {},
): Promise<EnsuredServer | undefined> {
  const probe = deps.probe ?? defaultProbe;
  const attached = (url: string): EnsuredServer => ({
    url,
    owned: false,
    onExit: () => {},
    stop: async () => {},
  });

  const explicit = config.gateway.serverUrl;
  if (explicit) {
    if (await probe(explicit)) return attached(explicit);
    logger.error(
      `Cannot reach the opencode server at ${explicit}. Start it with \`opencode serve\`, or drop gateway.serverUrl / OPENCODE_SERVER_URL to let the gateway launch its own.`,
    );
    return undefined;
  }
  if (await probe(DEFAULT_OPENCODE_SERVER_URL)) {
    logger.info("gateway.opencode_attach", { url: DEFAULT_OPENCODE_SERVER_URL });
    return attached(DEFAULT_OPENCODE_SERVER_URL);
  }
  return spawnManaged(config, logger, probe, deps);
}

async function spawnManaged(
  config: ResolvedConfig,
  logger: GatewayLogger,
  probe: (url: string) => Promise<boolean>,
  deps: ServeDeps,
): Promise<EnsuredServer | undefined> {
  const { port } = config.gateway.serve;
  const bin = resolveOpencodeBin(config.gateway.serve.bin);
  const url = `http://127.0.0.1:${port}`;
  const cwd = config.gateway.projectDirectory ?? process.cwd();
  logger.info("gateway.opencode_spawn", { bin, port, cwd });

  const child = (deps.spawnServe ?? defaultSpawn)(
    bin,
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd, env: process.env },
  );

  let ready = false;
  let stopping = false;
  let exitCode: number | null | undefined;
  let spawnErr: NodeJS.ErrnoException | undefined;
  const exitCallbacks: Array<(code: number | null) => void> = [];
  const settle = (code: number | null) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    if (ready && !stopping) for (const cb of exitCallbacks) cb(code);
  };
  child.once("exit", (code) => settle(code));
  child.once("error", (err) => {
    spawnErr = err as NodeJS.ErrnoException;
    settle(null);
  });

  const timeoutMs = deps.timeoutMs ?? 60_000;
  const pollMs = deps.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      logger.error(
        spawnErr?.code === "ENOENT"
          ? `opencode binary "${bin}" not found — install opencode (npm install -g opencode-ai), or set gateway.serverUrl / INKBOX_OPENCODE_BIN.`
          : `\`${bin} serve\` exited (code ${exitCode}) before becoming reachable at ${url}.`,
      );
      return undefined;
    }
    if (await probe(url)) {
      ready = true;
      logger.info("gateway.opencode_ready", { url });
      return {
        url,
        owned: true,
        onExit: (cb) => {
          exitCallbacks.push(cb);
          if (exitCode !== undefined && !stopping) cb(exitCode);
        },
        stop: async () => {
          stopping = true;
          if (exitCode !== undefined) return;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          const grace = Date.now() + 5_000;
          while (Date.now() < grace && exitCode === undefined) await delay(50);
          if (exitCode === undefined) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
        },
      };
    }
    await delay(pollMs);
  }

  logger.error(
    `Managed opencode server did not become reachable at ${url} within ${Math.round(timeoutMs / 1000)}s.`,
  );
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  return undefined;
}
