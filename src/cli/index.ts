import { resolveConfig } from "../config.js";
import type { GatewayLogger } from "../gateway/types.js";
import {
  type AutostartStatus,
  autostartStatus,
  installAutostart,
  uninstallAutostart,
} from "./autostart.js";
import { daemonStatus, restartDaemon, runUninstall, startDaemon, stopDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { loadEnvFile } from "./env-file.js";
import { runForeground, runWhoami } from "./run.js";
import { runSetup } from "./setup.js";
import { runWizard } from "./wizard.js";

// Plain human-readable logger for CLI/sidecar output. Structured extras are
// appended compactly so foreground runs and daemon logs stay greppable.
const cliLogger: GatewayLogger = {
  info: (m, e) => console.log(format(m, e)),
  warn: (m, e) => console.warn(format(m, e)),
  error: (m, e) => console.error(format(m, e)),
};

function format(msg: string, extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return msg;
  return `${msg} ${JSON.stringify(extra)}`;
}

const USAGE = `inkbox-opencode — Inkbox inbound gateway for opencode

Usage: inkbox-opencode <command>

Commands:
  run         Run the gateway in the foreground (owns this process).
  start       Start the gateway as a background daemon.
  stop        Stop the background daemon.
  restart     Restart the background daemon.
  status      Report the background daemon and the boot service.
  autostart   Boot service management: autostart install | uninstall | status.
  doctor      Diagnose configuration and connectivity.
  whoami      Print the resolved Inkbox agent identity.
  setup       Interactive setup wizard (--print for the static checklist).
  uninstall   Stop the daemon, remove the boot service and local state.

The gateway attaches to an opencode server at OPENCODE_SERVER_URL (or
http://127.0.0.1:4096); when neither answers it launches its own managed
\`opencode serve\`. Credentials resolve from plugin options, env vars, an env
file (INKBOX_OPENCODE_ENV_FILE, ./.env, ~/.inkbox-opencode/.env), then
~/.inkbox/config.
`;

function isHelp(arg: string | undefined): boolean {
  return arg === undefined || arg === "help" || arg === "--help" || arg === "-h";
}

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];

  if (isHelp(command)) {
    console.log(USAGE);
    return 0;
  }

  // Daemon-parity env loading: fill missing vars from the first env file so
  // every command sees the same config the boot service would. The sources
  // map feeds setup/doctor provenance (which file — or the shell — won a var).
  const envSources = new Map<string, string>();
  loadEnvFile(process.env, process.cwd(), envSources);

  switch (command) {
    case "run":
      return runForeground(resolveConfig(undefined), cliLogger);
    case "start":
      return startDaemon();
    case "stop":
      return stopDaemon();
    case "restart":
      return restartDaemon();
    case "status": {
      const code = await daemonStatus();
      const auto = autostartStatus();
      printAutostart(auto);
      return auto.active ? 0 : code;
    }
    case "autostart":
      return runAutostart(argv[1]);
    case "whoami":
      return runWhoami(resolveConfig(undefined), cliLogger);
    case "setup": {
      // Interactive wizard on a terminal; static checklist when piped/--print.
      const interactive = argv[1] !== "--print" && process.stdin.isTTY === true;
      const config = resolveConfig(undefined);
      return interactive ? runWizard(config, { envSources }) : runSetup(config);
    }
    case "uninstall": {
      if (!uninstallAutostart()) console.log("No boot service installed.");
      return runUninstall();
    }
    case "doctor": {
      const { ok } = await runDoctor(resolveConfig(undefined), { envSources });
      return ok ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

function printAutostart(auto: AutostartStatus): void {
  if (!auto.supported) return;
  if (!auto.installed) {
    console.log("Boot service: not installed (`inkbox-opencode autostart install`).");
    return;
  }
  const state = `${auto.enabled ? "enabled" : "disabled"}, ${auto.active ? "active" : "inactive"}`;
  console.log(`Boot service: ${auto.path} (${state}).`);
}

async function runAutostart(action: string | undefined): Promise<number> {
  switch (action ?? "status") {
    case "install":
      return (await installAutostart()) ? 0 : 1;
    case "uninstall":
      if (!uninstallAutostart()) console.log("No boot service installed.");
      return 0;
    case "status": {
      const auto = autostartStatus();
      if (!auto.supported) {
        console.log("Boot autostart is not supported on this platform.");
        return 1;
      }
      printAutostart(auto);
      return auto.installed && auto.active ? 0 : 3;
    }
    default:
      console.error(
        `Unknown autostart action: ${action}\nUsage: inkbox-opencode autostart install | uninstall | status`,
      );
      return 2;
  }
}
