import { resolveConfig } from "../config.js";
import type { GatewayLogger } from "../gateway/types.js";
import { daemonStatus, restartDaemon, runUninstall, startDaemon, stopDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { runForeground, runWhoami } from "./run.js";
import { runSetup } from "./setup.js";

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
  status      Report whether the background daemon is running.
  doctor      Diagnose configuration and connectivity.
  whoami      Print the resolved Inkbox agent identity.
  setup       Print the env vars and opencode.json the gateway needs.
  uninstall   Stop the daemon and remove local gateway state.

Credentials resolve from plugin options, env vars, then ~/.inkbox/config.
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

  switch (command) {
    case "run":
      return runForeground(resolveConfig(undefined), cliLogger);
    case "start":
      return startDaemon();
    case "stop":
      return stopDaemon();
    case "restart":
      return restartDaemon();
    case "status":
      return daemonStatus();
    case "whoami":
      return runWhoami(resolveConfig(undefined), cliLogger);
    case "setup":
      return runSetup(resolveConfig(undefined));
    case "uninstall":
      return runUninstall();
    case "doctor": {
      const { ok } = await runDoctor(resolveConfig(undefined));
      return ok ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}
