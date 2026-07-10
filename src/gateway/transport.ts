import { connect } from "@inkbox/sdk/tunnels/connect";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedGatewayConfig } from "../config.js";
import type { GatewayLogger, StateStoreLike } from "./transport-types.js";

export interface Transport {
  // Public base URL webhooks and the call WS are reachable at.
  publicUrl: string;
  close(): Promise<void>;
}

// Bring up the inbound transport: either the Inkbox tunnel (forwarding to the
// local webhook server) or a caller-provided public URL. `ownsProcess` is
// false when running inside a host we don't control (in-plugin mode), which
// forbids the tunnel client from installing its own signal handlers.
export async function openTransport(opts: {
  inkbox: InkboxRuntime;
  gateway: ResolvedGatewayConfig;
  localUrl: string;
  ownsProcess: boolean;
  state: StateStoreLike;
  logger: GatewayLogger;
}): Promise<Transport> {
  const { gateway, localUrl, ownsProcess, logger } = opts;

  if (gateway.publicUrl) {
    logger.info("transport.public_url", { publicUrl: gateway.publicUrl });
    return { publicUrl: gateway.publicUrl, close: async () => {} };
  }

  const name = gateway.tunnelName;
  if (!name) {
    throw new Error(
      "Gateway needs a tunnel name (defaults to the identity handle) or a publicUrl. Set gateway.tunnelName or gateway.publicUrl.",
    );
  }

  const client = await opts.inkbox.getClient();
  const listener = await connect(client, {
    name,
    forwardTo: localUrl,
    // Only a process we own may take over SIGINT/SIGTERM.
    installSignalHandlers: ownsProcess,
  });
  opts.state.update({ tunnelId: listener.tunnel?.id });
  logger.info("transport.tunnel", { publicUrl: listener.publicUrl });
  return {
    publicUrl: listener.publicUrl,
    close: () => listener.close(),
  };
}
