import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createInkboxRuntime, type InkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { inkboxErrorMessage } from "../errors.js";
import { startGateway } from "../gateway/index.js";
import type { GatewayLogger } from "../gateway/types.js";
import {
  DEFAULT_OPENCODE_SERVER_URL,
  type EnsuredServer,
  ensureOpencodeServer,
  opencodeReachable,
  type ServeDeps,
} from "./serve.js";

export { DEFAULT_OPENCODE_SERVER_URL, opencodeReachable } from "./serve.js";

function runtimeFor(config: ResolvedConfig): InkboxRuntime {
  return createInkboxRuntime(() => ({
    apiKey: config.apiKey,
    identity: config.identity,
    baseUrl: config.baseUrl,
  }));
}

export interface RunDeps {
  runtime?: InkboxRuntime;
  opencode?: OpencodeClient;
  serve?: ServeDeps;
}

// Run the inbound gateway in the foreground. This is the one place a signal
// handler is legitimate: the sidecar owns its process, so SIGINT/SIGTERM must
// tear the gateway down before exit. Resolves after a clean shutdown, or with
// code 1 when a managed opencode server dies (a service manager restarts us).
export async function runForeground(
  config: ResolvedConfig,
  logger: GatewayLogger,
  deps: RunDeps = {},
): Promise<number> {
  if (!config.apiKey || !config.identity) {
    logger.error(NOT_CONFIGURED_MESSAGE);
    return 1;
  }

  // An injected client bypasses server management (tests, embedders).
  let server: EnsuredServer;
  if (deps.opencode) {
    server = {
      url: config.gateway.serverUrl ?? DEFAULT_OPENCODE_SERVER_URL,
      owned: false,
      onExit: () => {},
      stop: async () => {},
    };
    if (!(await opencodeReachable(deps.opencode))) {
      logger.error(`Cannot reach the opencode server at ${server.url}.`);
      return 1;
    }
  } else {
    const ensured = await ensureOpencodeServer(config, logger, deps.serve);
    if (!ensured) return 1;
    server = ensured;
  }
  const opencode = deps.opencode ?? createOpencodeClient({ baseUrl: server.url });

  const runtime = deps.runtime ?? runtimeFor(config);
  const directory = config.gateway.projectDirectory ?? process.cwd();

  let handle: Awaited<ReturnType<typeof startGateway>>;
  try {
    handle = await startGateway({
      inkbox: runtime,
      opencode,
      config,
      directory,
      ownsProcess: true,
      logger,
    });
  } catch (err) {
    await server.stop();
    throw err;
  }
  logger.info("gateway.foreground", {
    publicUrl: handle.publicUrl,
    opencode: server.url,
    managedServe: server.owned,
  });
  console.log(`Gateway is running. Public URL: ${handle.publicUrl}`);
  if (server.owned) console.log(`Managed opencode server: ${server.url}`);
  console.log("Press Ctrl+C to stop.");

  const code = await waitForExit(handle.close.bind(handle), server, logger);
  await server.stop();
  return code;
}

// Resolve on SIGINT/SIGTERM (clean, code 0) or when an owned opencode server
// dies (code 1 so a service manager restarts the pair together). Closes the
// gateway before resolving either way.
function waitForExit(
  close: () => Promise<void>,
  server: EnsuredServer,
  logger: GatewayLogger,
): Promise<number> {
  return new Promise((resolve) => {
    let closing = false;
    const finish = (code: number, reason: string) => {
      if (closing) return;
      closing = true;
      logger.info("gateway.shutdown", { reason });
      close().then(
        () => resolve(code),
        (err) => {
          logger.error("gateway.shutdown_failed", { error: String(err) });
          resolve(code || 1);
        },
      );
    };
    process.once("SIGINT", () => finish(0, "SIGINT"));
    process.once("SIGTERM", () => finish(0, "SIGTERM"));
    server.onExit((code) => {
      logger.error("gateway.opencode_exited", { code });
      finish(1, "opencode_exited");
    });
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
