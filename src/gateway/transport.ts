import { connect } from "@inkbox/sdk/tunnels/connect";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedGatewayConfig } from "../config.js";
import type { GatewayLogger, StateStoreLike } from "./transport-types.js";

export interface Transport {
  // Public base URL webhooks and the call WS are reachable at.
  publicUrl: string;
  close(): Promise<void>;
}

// How long the tunnel's first data-plane bind may take before startup fails
// loudly instead of leaving a gateway that 403s all inbound traffic.
const TUNNEL_CONNECT_TIMEOUT_MS = 15_000;

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
  let onConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    onConnected = resolve;
  });
  const listener = await connect(client, {
    name,
    forwardTo: localUrl,
    // Only a process we own may take over SIGINT/SIGTERM.
    installSignalHandlers: ownsProcess,
    onStatus: (status) => {
      logger.info("transport.tunnel_status", { status });
      if (status === "connected") onConnected();
    },
  });

  // connect() only provisions the listener — wait() is what dials and drives
  // the data plane. Run it for the tunnel's lifetime; a fatal error here
  // means inbound traffic has stopped, which must be loud in the logs.
  const served = listener.wait().then(
    () => logger.info("transport.tunnel_closed", {}),
    (err) => {
      logger.error("transport.tunnel_fatal", { error: String(err) });
      throw err;
    },
  );
  served.catch(() => {
    /* surfaced above and via the startup race below */
  });

  // Gate startup on the first successful bind: a tunnel that cannot connect
  // must fail startup, not silently reject every webhook and call.
  await raceFirstBind(connected, served, listener, name);

  opts.state.update({ tunnelId: listener.tunnel?.id });
  logger.info("transport.tunnel", { publicUrl: listener.publicUrl });
  return {
    publicUrl: listener.publicUrl,
    close: () => listener.close(),
  };
}

async function raceFirstBind(
  connected: Promise<void>,
  served: Promise<void>,
  listener: { close(): Promise<void> },
  name: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Tunnel "${name}" did not reach connected status within ` +
            `${TUNNEL_CONNECT_TIMEOUT_MS / 1000}s. Check connectivity and that ` +
            "the tunnel is provisioned for this identity.",
        ),
      );
    }, TUNNEL_CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
  // A serve loop that settles before "connected" — fatal error or clean
  // close — means the tunnel never came up; both must fail startup.
  const closedEarly = served.then(() => {
    throw new Error(`Tunnel "${name}" closed before reaching connected status.`);
  });
  try {
    await Promise.race([connected, closedEarly, timedOut]);
  } catch (err) {
    await listener.close().catch(() => {});
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
