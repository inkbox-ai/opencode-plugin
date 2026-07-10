import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  daemonPaths,
  daemonStatus,
  pidAlive,
  posixGuard,
  readPidFile,
  removeLauncherSymlinks,
  restartDaemon,
  runUninstall,
  startDaemon,
  stopDaemon,
} from "../../src/cli/daemon.js";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// A stubbed signal sender that models a live process which dies on SIGTERM.
function fakeProcess(startsAlive: boolean) {
  const state = { alive: startsAlive };
  const sent: string[] = [];
  const send = (_pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === "SIGTERM") {
      state.alive = false;
      sent.push("SIGTERM");
      return;
    }
    if (signal === "SIGKILL") {
      sent.push("SIGKILL");
      return;
    }
    // signal 0: probe. A dead process throws ESRCH like the real kernel.
    if (!state.alive) {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
  };
  return { send, sent, state };
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-cli-daemon-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("readPidFile", () => {
  it("reads a valid pid and rejects garbage or a missing file", () => {
    const { pidFile } = daemonPaths(home);
    fs.writeFileSync(pidFile, "4321\n");
    expect(readPidFile(pidFile)).toBe(4321);

    fs.writeFileSync(pidFile, "not-a-pid");
    expect(readPidFile(pidFile)).toBeUndefined();

    fs.rmSync(pidFile);
    expect(readPidFile(pidFile)).toBeUndefined();
  });
});

describe("pidAlive", () => {
  it("treats no-throw and EPERM as alive, ESRCH as dead", () => {
    expect(pidAlive(1, () => {})).toBe(true);
    expect(
      pidAlive(1, () => {
        const err = new Error("perm") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }),
    ).toBe(true);
    expect(
      pidAlive(1, () => {
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }),
    ).toBe(false);
  });

  it("reports this live process as alive with the real sender", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});

describe("posixGuard", () => {
  it("is silent on POSIX and returns a message on win32", () => {
    setPlatform("linux");
    expect(posixGuard()).toBeUndefined();
    setPlatform("win32");
    expect(posixGuard()).toMatch(/not supported on Windows/i);
  });
});

describe("startDaemon", () => {
  it("refuses on win32 without spawning", async () => {
    setPlatform("win32");
    const code = await startDaemon({ home });
    expect(code).toBe(1);
    // No pid file is written when the platform guard blocks the start.
    expect(fs.existsSync(daemonPaths(home).pidFile)).toBe(false);
  });

  it("refuses to start when a live daemon is already recorded", async () => {
    const { pidFile } = daemonPaths(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const code = await startDaemon({ home });
    expect(code).toBe(1);
    // The existing (live) pid is left untouched.
    expect(readPidFile(pidFile)).toBe(process.pid);
  });
});

describe("stopDaemon", () => {
  it("is a no-op when no pid file exists", async () => {
    const code = await stopDaemon({ home });
    expect(code).toBe(0);
  });

  it("removes a stale pid file for a dead process", async () => {
    const { pidFile } = daemonPaths(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, "999999\n");
    const { send } = fakeProcess(false);
    const code = await stopDaemon({ home, send });
    expect(code).toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("SIGTERMs a live process, then removes the pid file", async () => {
    const { pidFile } = daemonPaths(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, "12345\n");
    const { send, sent } = fakeProcess(true);
    const code = await stopDaemon({ home, send });
    expect(code).toBe(0);
    expect(sent).toEqual(["SIGTERM"]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("daemonStatus", () => {
  it("returns 0 when the recorded pid is alive", async () => {
    const { pidFile } = daemonPaths(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    expect(await daemonStatus({ home })).toBe(0);
  });

  it("returns 3 when not running or the pid is stale", async () => {
    expect(await daemonStatus({ home })).toBe(3);

    const { pidFile } = daemonPaths(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(pidFile, "999999\n");
    const { send } = fakeProcess(false);
    expect(await daemonStatus({ home, send })).toBe(3);
  });
});

describe("restartDaemon", () => {
  it("aborts the restart when the platform guard blocks stop", async () => {
    setPlatform("win32");
    expect(await restartDaemon({ home })).toBe(1);
  });
});

describe("removeLauncherSymlinks", () => {
  it("removes only symlinks that resolve into an Inkbox checkout", () => {
    const bin = path.join(home, "bin");
    const app = path.join(home, "inkbox-opencode-app");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "cli.js"), "#!/usr/bin/env node\n");

    const ours = path.join(bin, "inkbox-opencode");
    fs.symlinkSync(path.join(app, "cli.js"), ours);
    expect(removeLauncherSymlinks([bin])).toEqual([ours]);
    expect(fs.existsSync(ours)).toBe(false);

    // A same-named real file (not ours) is left alone.
    fs.writeFileSync(ours, "someone else's binary\n");
    expect(removeLauncherSymlinks([bin])).toEqual([]);
    expect(fs.existsSync(ours)).toBe(true);
  });
});

describe("runUninstall", () => {
  it("removes pid, log, session map, and the autostart env snapshot", async () => {
    fs.mkdirSync(home, { recursive: true });
    const files = ["gateway.pid", "gateway.log", "state.json", ".env"].map((f) =>
      path.join(home, f),
    );
    // A dead pid so uninstall doesn't try to signal anything real.
    fs.writeFileSync(files[0], "999999\n");
    for (const f of files.slice(1)) fs.writeFileSync(f, "x\n");
    const { send } = fakeProcess(false);
    expect(await runUninstall({ home, send, launcherDirs: [] })).toBe(0);
    for (const f of files) expect(fs.existsSync(f)).toBe(false);
  });
});
