import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatewayHome } from "../gateway/state.js";

// POSIX-style background daemon for the sidecar gateway. Node has no true
// double-fork, so `start` spawns a detached child running `run`, records its
// pid, and unrefs it; the parent CLI exits while the child keeps running.

type SignalArg = NodeJS.Signals | 0;
type SendSignal = (pid: number, signal: SignalArg) => void;

const defaultSend: SendSignal = (pid, signal) => {
  process.kill(pid, signal);
};

export interface DaemonOptions {
  // Overridable so tests can point at a scratch home.
  home?: string;
  // Script the detached child runs (`node <entry> run`). Defaults to the
  // script that invoked this process (the bin wrapper).
  entry?: string;
  // Injectable signal sender; defaults to process.kill.
  send?: SendSignal;
  // Dirs scanned for the launcher symlink on uninstall; tests use a sandbox.
  launcherDirs?: string[];
}

export interface DaemonPaths {
  home: string;
  pidFile: string;
  logFile: string;
}

export function daemonPaths(home: string = gatewayHome()): DaemonPaths {
  return {
    home,
    pidFile: path.join(home, "gateway.pid"),
    logFile: path.join(home, "gateway.log"),
  };
}

// Returns a message when the platform can't run the daemon, else undefined.
// Read at call time so the guard reflects the current process.platform.
export function posixGuard(): string | undefined {
  if (process.platform === "win32") {
    return "The background daemon is not supported on Windows. Run `inkbox-opencode run` in the foreground instead.";
  }
  return undefined;
}

export function readPidFile(pidFile: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(pidFile, "utf-8").trim();
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function writePidFile(pidFile: string, pid: number): void {
  fs.writeFileSync(pidFile, `${pid}\n`);
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort; a missing file is the desired end state anyway.
  }
}

// A signal-0 probe: no throw means alive, EPERM means alive-but-not-ours,
// anything else (ESRCH) means the process is gone.
export function pidAlive(pid: number, send: SendSignal = defaultSend): boolean {
  try {
    send(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<number> {
  const blocked = posixGuard();
  if (blocked) {
    console.error(blocked);
    return 1;
  }
  const { home, pidFile, logFile } = daemonPaths(opts.home);
  const send = opts.send ?? defaultSend;

  const existing = readPidFile(pidFile);
  if (existing !== undefined && pidAlive(existing, send)) {
    console.error(`Gateway already running (pid ${existing}). Use \`stop\` or \`restart\`.`);
    return 1;
  }
  if (existing !== undefined) removeFile(pidFile);

  fs.mkdirSync(home, { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  const entry = opts.entry ?? process.argv[1];
  try {
    const child = spawn(process.execPath, [entry, "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    if (child.pid === undefined) {
      console.error("Failed to spawn the gateway process.");
      return 1;
    }
    writePidFile(pidFile, child.pid);
    console.log(`Gateway started (pid ${child.pid}). Logs: ${logFile}`);
    return 0;
  } finally {
    fs.closeSync(logFd);
  }
}

export async function stopDaemon(opts: DaemonOptions = {}): Promise<number> {
  const blocked = posixGuard();
  if (blocked) {
    console.error(blocked);
    return 1;
  }
  const { pidFile } = daemonPaths(opts.home);
  const send = opts.send ?? defaultSend;

  const pid = readPidFile(pidFile);
  if (pid === undefined) {
    console.log("Gateway is not running (no pid file).");
    return 0;
  }
  if (!pidAlive(pid, send)) {
    removeFile(pidFile);
    console.log(`Gateway is not running; removed stale pid file (pid ${pid}).`);
    return 0;
  }

  // Guard the sends: the process can exit between the alive-check and the
  // signal, in which case the send throws ESRCH — treat that as stopped.
  const trySend = (signal: NodeJS.Signals): void => {
    try {
      send(pid, signal);
    } catch {
      /* already gone */
    }
  };
  trySend("SIGTERM");
  // Give it ~5s to exit gracefully, then force-kill.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(pid, send)) {
    await delay(100);
  }
  if (pidAlive(pid, send)) {
    trySend("SIGKILL");
  }
  removeFile(pidFile);
  console.log(`Gateway stopped (pid ${pid}).`);
  return 0;
}

export async function daemonStatus(opts: DaemonOptions = {}): Promise<number> {
  const blocked = posixGuard();
  if (blocked) {
    console.error(blocked);
    return 1;
  }
  const { pidFile, logFile } = daemonPaths(opts.home);
  const send = opts.send ?? defaultSend;

  const pid = readPidFile(pidFile);
  if (pid !== undefined && pidAlive(pid, send)) {
    console.log(`Gateway is running (pid ${pid}). Logs: ${logFile}`);
    return 0;
  }
  if (pid !== undefined) {
    console.log(`Gateway is not running (stale pid file for pid ${pid}).`);
    return 3;
  }
  console.log("Gateway is not running.");
  return 3;
}

export async function restartDaemon(opts: DaemonOptions = {}): Promise<number> {
  const stopped = await stopDaemon(opts);
  if (stopped !== 0) return stopped;
  return startDaemon(opts);
}

// Remove the installer's `inkbox-opencode` launcher from the given dirs; only
// unlinks symlinks that resolve into an Inkbox checkout, never a stranger's
// binary of the same name. Returns the removed paths.
export function removeLauncherSymlinks(
  dirs: string[] = [
    path.join(os.homedir(), ".local", "bin"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
  ],
): string[] {
  const removed: string[] = [];
  for (const dir of new Set(dirs)) {
    const link = path.join(dir, "inkbox-opencode");
    try {
      if (fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link).includes("inkbox")) {
        fs.rmSync(link);
        removed.push(link);
      }
    } catch {
      /* absent or unreadable — nothing to remove */
    }
  }
  return removed;
}

// Stop the daemon and delete local gateway state, then point the user at the
// manual steps (env vars, opencode.json) the CLI can't undo for them.
export async function runUninstall(opts: DaemonOptions = {}): Promise<number> {
  if (posixGuard() === undefined) {
    const { pidFile } = daemonPaths(opts.home);
    if (readPidFile(pidFile) !== undefined) await stopDaemon(opts);
  }
  const { home, pidFile, logFile } = daemonPaths(opts.home);
  removeFile(pidFile);
  removeFile(logFile);
  removeFile(path.join(home, "state.json"));
  removeFile(path.join(home, ".env")); // credentials snapshot from `autostart install`

  console.log("Removed local gateway state (pid, log, session map, autostart env).");
  for (const link of removeLauncherSymlinks(opts.launcherDirs)) {
    console.log(`Removed launcher ${link}`);
  }
  console.log("");
  console.log("To finish removing the gateway, do the following manually:");
  console.log("  1. Remove the .opencode/plugins/inkbox.ts wrapper (or its gateway options).");
  console.log(
    "  2. Unset INKBOX_API_KEY, INKBOX_IDENTITY, and INKBOX_SIGNING_KEY if you set them for the gateway.",
  );
  console.log("  3. Delete the cloned opencode-plugin repo if it is no longer needed.");
  return 0;
}
