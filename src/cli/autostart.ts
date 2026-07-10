import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatewayHome } from "../gateway/state.js";
import { daemonPaths, pidAlive, readPidFile, stopDaemon } from "./daemon.js";

// Boot/login autostart for the gateway: a systemd user unit on Linux, a
// launchd agent on macOS. The service runs `inkbox-opencode run`, which owns
// its opencode server, so one service is the whole always-on stack.

export const SERVICE_NAME = "inkbox-opencode";
export const LAUNCHD_LABEL = "ai.inkbox.opencode";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[]) => RunResult;

const execRunner: Runner = (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? (err instanceof Error ? err.message : err)),
    };
  }
};

export interface AutostartDeps {
  // Gateway state dir (env snapshot, pid/log files). Defaults to
  // ~/.inkbox-opencode (or INKBOX_OPENCODE_HOME).
  home?: string;
  // Account home, for the unit/plist locations. Defaults to os.homedir().
  osHome?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  // Node binary + bin script the service should exec (`node <entry> run`).
  execPath?: string;
  entry?: string;
  // WorkingDirectory for the service; gateway sessions default to it.
  projectDirectory?: string;
  print?: (line: string) => void;
  send?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

interface Ctx {
  home: string;
  osHome: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: Runner;
  execPath: string;
  entry: string;
  projectDirectory: string;
  print: (line: string) => void;
  send?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

function ctx(deps: AutostartDeps): Ctx {
  const env = deps.env ?? process.env;
  return {
    env,
    home: deps.home ?? gatewayHome(env),
    osHome: deps.osHome ?? os.homedir(),
    platform: deps.platform ?? process.platform,
    run: deps.run ?? execRunner,
    execPath: deps.execPath ?? process.execPath,
    entry: path.resolve(deps.entry ?? process.argv[1] ?? "inkbox-opencode"),
    projectDirectory: deps.projectDirectory ?? process.cwd(),
    print: deps.print ?? ((line: string) => console.log(line)),
    send: deps.send,
  };
}

export function systemdUnitPath(osHome: string): string {
  return path.join(osHome, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

export function launchdPlistPath(osHome: string): string {
  return path.join(osHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function autostartEnvPath(home: string): string {
  return path.join(home, ".env");
}

// Snapshot the gateway-relevant env (INKBOX_* + OPENAI_API_KEY) so the boot
// service sees the same credentials as the shell that installed it. Vars the
// service inherits for real always win over this file.
function writeAutostartEnv(c: Ctx): string {
  const file = autostartEnvPath(c.home);
  const keys = Object.keys(c.env)
    .filter(
      (k) =>
        (k.startsWith("INKBOX_") && k !== "INKBOX_OPENCODE_ENV_FILE") || k === "OPENAI_API_KEY",
    )
    .filter((k) => (c.env[k] ?? "").trim() !== "")
    .sort();
  const lines = [
    "# Written by `inkbox-opencode autostart install`.",
    "# Loaded by the boot service; real environment variables win.",
    "# Credentials absent here still resolve from ~/.inkbox/config.",
    ...keys.map((k) => `${k}=${c.env[k]}`),
    "",
  ];
  fs.mkdirSync(c.home, { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode above only applies when creating the file
  c.print(`  Wrote ${file} (${keys.length} vars captured; chmod 600).`);
  return file;
}

// The service manager owns the gateway from here on — stop a fork-based
// background daemon first so two gateways never fight over the tunnel.
async function stopForkDaemon(c: Ctx): Promise<void> {
  const { pidFile } = daemonPaths(c.home);
  const pid = readPidFile(pidFile);
  if (pid !== undefined && pidAlive(pid, c.send)) {
    await stopDaemon({ home: c.home, send: c.send });
  }
}

// Install and enable a service that runs the gateway on boot/login.
export async function installAutostart(deps: AutostartDeps = {}): Promise<boolean> {
  const c = ctx(deps);
  if (c.platform === "linux") return installSystemd(c);
  if (c.platform === "darwin") return installLaunchd(c);
  c.print(
    `  Boot autostart isn't supported on ${c.platform}. Use \`inkbox-opencode start\` instead.`,
  );
  return false;
}

async function installSystemd(c: Ctx): Promise<boolean> {
  const envFile = writeAutostartEnv(c);
  const unit = systemdUnitPath(c.osHome);
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(
    unit,
    [
      "[Unit]",
      "Description=Inkbox gateway for opencode",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `Environment=INKBOX_OPENCODE_ENV_FILE=${envFile}`,
      `WorkingDirectory=${c.projectDirectory}`,
      `ExecStart="${c.execPath}" "${c.entry}" run`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
  c.print(`  Wrote ${unit}`);

  await stopForkDaemon(c);

  const user = c.env.USER || c.env.LOGNAME || "";
  c.run("systemctl", ["--user", "daemon-reload"]);
  // `enable --now` is a no-op on an already-running service, which would keep
  // a stale gateway on old credentials — so enable, then always restart.
  c.run("systemctl", ["--user", "enable", `${SERVICE_NAME}.service`]);
  const restarted = c.run("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]);
  if (restarted.code === 0) {
    const linger = c.run("loginctl", ["enable-linger", user]);
    c.print("  Enabled — the gateway is running now and will start on boot.");
    if (linger.code !== 0) {
      c.print(
        `  To keep it running while logged out: sudo loginctl enable-linger ${user || "$USER"}`,
      );
    }
    c.print(`  Manage it: systemctl --user status|restart|stop ${SERVICE_NAME}`);
    return true;
  }

  const detail = restarted.stderr.trim().split("\n").filter(Boolean).pop();
  c.print("  Could not enable the systemd user service automatically.");
  if (detail) c.print(`    ${detail}`);
  c.print("  The unit is written — enable it once a user session exists:");
  c.print(`    loginctl enable-linger ${user || "$USER"}`);
  c.print("    systemctl --user daemon-reload");
  c.print(`    systemctl --user enable ${SERVICE_NAME}.service`);
  c.print(`    systemctl --user restart ${SERVICE_NAME}.service`);
  return false;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function installLaunchd(c: Ctx): Promise<boolean> {
  const envFile = writeAutostartEnv(c);
  const plist = launchdPlistPath(c.osHome);
  const log = daemonPaths(c.home).logFile;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      `  <array><string>${xml(c.execPath)}</string><string>${xml(c.entry)}</string><string>run</string></array>`,
      "  <key>EnvironmentVariables</key>",
      `  <dict><key>INKBOX_OPENCODE_ENV_FILE</key><string>${xml(envFile)}</string></dict>`,
      `  <key>WorkingDirectory</key><string>${xml(c.projectDirectory)}</string>`,
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  c.print(`  Wrote ${plist}`);

  await stopForkDaemon(c);
  c.run("launchctl", ["unload", plist]);
  const loaded = c.run("launchctl", ["load", "-w", plist]);
  if (loaded.code === 0) {
    c.print("  Loaded — the gateway is running now and will start at login.");
    c.print(`  Manage it: launchctl unload/load ${plist}`);
    return true;
  }
  c.print("  Could not load the launchd agent automatically.");
  const detail = loaded.stderr.trim();
  if (detail) c.print(`    ${detail}`);
  c.print(`  Load it yourself: launchctl load -w ${plist}`);
  return false;
}

// Disable and remove the boot/login service. Returns false when none exists.
export function uninstallAutostart(deps: AutostartDeps = {}): boolean {
  const c = ctx(deps);
  if (c.platform === "linux") {
    const unit = systemdUnitPath(c.osHome);
    if (!fs.existsSync(unit)) return false;
    c.run("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
    fs.rmSync(unit, { force: true });
    c.run("systemctl", ["--user", "daemon-reload"]);
    c.print(`  Removed systemd service ${unit}`);
    return true;
  }
  if (c.platform === "darwin") {
    const plist = launchdPlistPath(c.osHome);
    if (!fs.existsSync(plist)) return false;
    c.run("launchctl", ["unload", "-w", plist]);
    fs.rmSync(plist, { force: true });
    c.print(`  Removed launchd agent ${plist}`);
    return true;
  }
  return false;
}

export interface AutostartStatus {
  supported: boolean;
  installed: boolean;
  path?: string;
  enabled?: boolean;
  active?: boolean;
}

export function autostartStatus(deps: AutostartDeps = {}): AutostartStatus {
  const c = ctx(deps);
  if (c.platform === "linux") {
    const unit = systemdUnitPath(c.osHome);
    if (!fs.existsSync(unit)) return { supported: true, installed: false, path: unit };
    const enabled =
      c.run("systemctl", ["--user", "is-enabled", `${SERVICE_NAME}.service`]).stdout.trim() ===
      "enabled";
    const active =
      c.run("systemctl", ["--user", "is-active", `${SERVICE_NAME}.service`]).stdout.trim() ===
      "active";
    return { supported: true, installed: true, path: unit, enabled, active };
  }
  if (c.platform === "darwin") {
    const plist = launchdPlistPath(c.osHome);
    if (!fs.existsSync(plist)) return { supported: true, installed: false, path: plist };
    // `launchctl list <label>` exits 0 only when the job is loaded.
    const active = c.run("launchctl", ["list", LAUNCHD_LABEL]).code === 0;
    return { supported: true, installed: true, path: plist, enabled: true, active };
  }
  return { supported: false, installed: false };
}
