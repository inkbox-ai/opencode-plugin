import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createInkboxRuntime, type InkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { inkboxErrorMessage } from "../errors.js";
import { startGateway } from "../gateway/index.js";
import type { GatewayLogger } from "../gateway/types.js";

// opencode's default server bind. The sidecar talks to a running
// `opencode serve` over HTTP; without a configured serverUrl we assume this.
export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:4096";

function runtimeFor(config: ResolvedConfig): InkboxRuntime {
  return createInkboxRuntime(() => ({
    apiKey: config.apiKey,
    identity: config.identity,
    baseUrl: config.baseUrl,
  }));
}

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

export interface RunDeps {
  runtime?: InkboxRuntime;
  opencode?: OpencodeClient;
}

// Run the inbound gateway in the foreground. This is the one place a signal
// handler is legitimate: the sidecar owns its process, so SIGINT/SIGTERM must
// tear the gateway down before exit. Resolves after a clean shutdown.
export async function runForeground(
  config: ResolvedConfig,
  logger: GatewayLogger,
  deps: RunDeps = {},
): Promise<number> {
  if (!config.apiKey || !config.identity) {
    logger.error(NOT_CONFIGURED_MESSAGE);
    return 1;
  }

  const serverUrl = config.gateway.serverUrl ?? DEFAULT_OPENCODE_SERVER_URL;
  const opencode = deps.opencode ?? createOpencodeClient({ baseUrl: serverUrl });

  if (!(await opencodeReachable(opencode))) {
    logger.error(
      `Cannot reach the opencode server at ${serverUrl}. Start it with \`opencode serve\` and set gateway.serverUrl (or the OPENCODE_SERVER_URL env var) if it listens elsewhere.`,
    );
    return 1;
  }

  const runtime = deps.runtime ?? runtimeFor(config);
  const directory = config.gateway.projectDirectory ?? process.cwd();

  const handle = await startGateway({
    inkbox: runtime,
    opencode,
    config,
    directory,
    ownsProcess: true,
    logger,
  });
  logger.info("gateway.foreground", { publicUrl: handle.publicUrl });
  console.log(`Gateway is running. Public URL: ${handle.publicUrl}`);
  console.log("Press Ctrl+C to stop.");

  await waitForSignal(handle.close.bind(handle), logger);
  return 0;
}

function waitForSignal(close: () => Promise<void>, logger: GatewayLogger): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      logger.info("gateway.shutdown", { signal });
      close().then(
        () => resolve(),
        (err) => {
          logger.error("gateway.shutdown_failed", { error: String(err) });
          resolve();
        },
      );
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
}

// Print the resolved Inkbox agent identity — a fast way to confirm the
// configured key and handle actually map to a live agent.
export async function runWhoami(
  config: ResolvedConfig,
  logger: GatewayLogger,
  deps: Pick<RunDeps, "runtime"> = {},
): Promise<number> {
  if (!config.apiKey || !config.identity) {
    logger.error(NOT_CONFIGURED_MESSAGE);
    return 1;
  }
  const runtime = deps.runtime ?? runtimeFor(config);
  try {
    const id = await runtime.getIdentity();
    console.log(`handle:     ${id.agentHandle}`);
    console.log(`name:       ${id.displayName ?? id.agentHandle}`);
    console.log(`email:      ${id.emailAddress ?? "(none)"}`);
    console.log(`phone:      ${id.phoneNumber?.number ?? "(none)"}`);
    console.log(
      `imessage:   ${(id as { imessageEnabled?: boolean }).imessageEnabled ? "on" : "off"}`,
    );
    return 0;
  } catch (err) {
    logger.error(`Could not resolve identity "${config.identity}": ${inkboxErrorMessage(err)}`);
    return 1;
  }
}
