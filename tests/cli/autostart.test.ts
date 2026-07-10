import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AutostartDeps,
  autostartEnvPath,
  autostartStatus,
  installAutostart,
  LAUNCHD_LABEL,
  launchdPlistPath,
  type RunResult,
  SERVICE_NAME,
  systemdUnitPath,
  uninstallAutostart,
} from "../../src/cli/autostart.js";

let home: string;
let osHome: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-autostart-state-"));
  osHome = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-autostart-home-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(osHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Records every external command; per-prefix overrides fake failures/output.
function fakeRunner(results: Record<string, Partial<RunResult>> = {}) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(" ")}`;
    const hit = Object.entries(results).find(([prefix]) => key.startsWith(prefix));
    return { code: 0, stdout: "", stderr: "", ...(hit ? hit[1] : {}) };
  };
  return { run, calls };
}

function deps(overrides: Partial<AutostartDeps> = {}): AutostartDeps {
  return {
    home,
    osHome,
    platform: "linux",
    env: { USER: "me" },
    execPath: "/usr/bin/node",
    entry: "/repo/bin/inkbox-opencode.js",
    projectDirectory: "/work/agent",
    print: () => {},
    ...overrides,
  };
}

describe("installAutostart (systemd)", () => {
  it("writes the unit + env snapshot, enables, restarts, and lingers", async () => {
    const { run, calls } = fakeRunner();
    const env = {
      USER: "me",
      INKBOX_API_KEY: "k",
      OPENAI_API_KEY: "o",
      INKBOX_OPENCODE_ENV_FILE: "/should/not/capture",
      PATH: "/usr/bin",
    };
    const ok = await installAutostart(deps({ run, env }));
    expect(ok).toBe(true);

    const unit = systemdUnitPath(osHome);
    const unitText = fs.readFileSync(unit, "utf-8");
    expect(unitText).toContain('ExecStart="/usr/bin/node" "/repo/bin/inkbox-opencode.js" run');
    expect(unitText).toContain(`Environment=INKBOX_OPENCODE_ENV_FILE=${autostartEnvPath(home)}`);
    expect(unitText).toContain("WorkingDirectory=/work/agent");
    expect(unitText).toContain("WantedBy=default.target");

    const envFile = autostartEnvPath(home);
    const envText = fs.readFileSync(envFile, "utf-8");
    expect(envText).toContain("INKBOX_API_KEY=k");
    expect(envText).toContain("OPENAI_API_KEY=o");
    expect(envText).not.toContain("PATH=");
    expect(envText).not.toContain("INKBOX_OPENCODE_ENV_FILE");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);

    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls).toContainEqual(["systemctl", "--user", "enable", `${SERVICE_NAME}.service`]);
    expect(calls).toContainEqual(["systemctl", "--user", "restart", `${SERVICE_NAME}.service`]);
    expect(calls).toContainEqual(["loginctl", "enable-linger", "me"]);
  });

  it("stops a fork-based daemon before the service takes over", async () => {
    const pidFile = path.join(home, "gateway.pid");
    fs.writeFileSync(pidFile, "12345\n");
    const alive = { value: true };
    const send = (_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") {
        alive.value = false;
        return;
      }
      if (signal === 0 && !alive.value) {
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    };
    const { run } = fakeRunner();
    expect(await installAutostart(deps({ run, send }))).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("reports failure but leaves the unit written when restart fails", async () => {
    const lines: string[] = [];
    const { run } = fakeRunner({
      "systemctl --user restart": { code: 1, stderr: "Failed to connect to bus" },
    });
    const ok = await installAutostart(deps({ run, print: (l) => lines.push(l) }));
    expect(ok).toBe(false);
    expect(fs.existsSync(systemdUnitPath(osHome))).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("Failed to connect to bus");
    expect(out).toContain("loginctl enable-linger me");
  });

  it("refuses unsupported platforms with a pointer at `start`", async () => {
    const lines: string[] = [];
    const { run } = fakeRunner();
    const ok = await installAutostart(
      deps({ run, platform: "win32", print: (l) => lines.push(l) }),
    );
    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/isn't supported on win32/);
  });
});

describe("installAutostart (launchd)", () => {
  it("writes the plist and loads it with -w", async () => {
    const { run, calls } = fakeRunner();
    const ok = await installAutostart(deps({ run, platform: "darwin" }));
    expect(ok).toBe(true);

    const plist = launchdPlistPath(osHome);
    const text = fs.readFileSync(plist, "utf-8");
    expect(text).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(text).toContain("<string>/usr/bin/node</string>");
    expect(text).toContain("<string>/repo/bin/inkbox-opencode.js</string>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><true/>");

    expect(calls).toContainEqual(["launchctl", "unload", plist]);
    expect(calls).toContainEqual(["launchctl", "load", "-w", plist]);
  });

  it("reports failure when launchctl load fails", async () => {
    const { run } = fakeRunner({ "launchctl load": { code: 1, stderr: "nope" } });
    const lines: string[] = [];
    const ok = await installAutostart(
      deps({ run, platform: "darwin", print: (l) => lines.push(l) }),
    );
    expect(ok).toBe(false);
    expect(lines.join("\n")).toContain("launchctl load -w");
  });
});

describe("uninstallAutostart", () => {
  it("disables and removes the systemd unit", () => {
    const unit = systemdUnitPath(osHome);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, "[Unit]\n");
    const { run, calls } = fakeRunner();
    expect(uninstallAutostart(deps({ run }))).toBe(true);
    expect(fs.existsSync(unit)).toBe(false);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      `${SERVICE_NAME}.service`,
    ]);
  });

  it("returns false when nothing is installed", () => {
    const { run } = fakeRunner();
    expect(uninstallAutostart(deps({ run }))).toBe(false);
    expect(uninstallAutostart(deps({ run, platform: "darwin" }))).toBe(false);
  });

  it("unloads and removes the launchd plist", () => {
    const plist = launchdPlistPath(osHome);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist/>\n");
    const { run, calls } = fakeRunner();
    expect(uninstallAutostart(deps({ run, platform: "darwin" }))).toBe(true);
    expect(fs.existsSync(plist)).toBe(false);
    expect(calls).toContainEqual(["launchctl", "unload", "-w", plist]);
  });
});

describe("autostartStatus", () => {
  it("reports not-installed when the unit is missing", () => {
    const { run } = fakeRunner();
    const status = autostartStatus(deps({ run }));
    expect(status).toMatchObject({ supported: true, installed: false });
    expect(status.path).toBe(systemdUnitPath(osHome));
  });

  it("reads enabled/active from systemctl", () => {
    const unit = systemdUnitPath(osHome);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, "[Unit]\n");
    const { run } = fakeRunner({
      "systemctl --user is-enabled": { stdout: "enabled\n" },
      "systemctl --user is-active": { stdout: "active\n" },
    });
    expect(autostartStatus(deps({ run }))).toMatchObject({
      installed: true,
      enabled: true,
      active: true,
    });
  });

  it("treats a loaded launchd job as active", () => {
    const plist = launchdPlistPath(osHome);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist/>\n");
    const loaded = fakeRunner({ "launchctl list": { code: 0 } });
    expect(autostartStatus(deps({ run: loaded.run, platform: "darwin" })).active).toBe(true);
    const unloaded = fakeRunner({ "launchctl list": { code: 113 } });
    expect(autostartStatus(deps({ run: unloaded.run, platform: "darwin" })).active).toBe(false);
  });

  it("marks unsupported platforms", () => {
    const { run } = fakeRunner();
    expect(autostartStatus(deps({ run, platform: "win32" }))).toEqual({
      supported: false,
      installed: false,
    });
  });
});
