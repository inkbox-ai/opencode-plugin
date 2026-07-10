import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ResolvedConfig } from "../config.js";
import type { RequestDedup } from "./dedup.js";
import { matchProvider, resolveProviderSecret } from "./providers.js";
import type { GatewayLogger, VerifiedEvent, WebhookProvider } from "./types.js";

export interface WebhookServerDeps {
  config: ResolvedConfig;
  logger: GatewayLogger;
  dedup: RequestDedup;
  providers?: readonly WebhookProvider[];
  env?: NodeJS.ProcessEnv;
  // Handle a verified inbound event. Return false to have the id rolled back
  // (so the sender may retry); throwing is treated the same way.
  onEvent(event: VerifiedEvent): Promise<boolean | undefined>;
  // Optional live-call WebSocket upgrade handler (set when voice is enabled).
  onCallUpgrade?(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void;
}

export interface WebhookServer {
  server: Server;
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 30 * 1024 * 1024;

// The gateway's inbound HTTP surface: GET /health, POST /webhook (verified,
// deduped, dispatched), and a WS upgrade path for live-call media. Verification
// keys off the provider that signed the request, never the body's claims.
export function createWebhookServer(deps: WebhookServerDeps): WebhookServer {
  const providers = deps.providers ?? undefined;
  const env = deps.env ?? process.env;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      deps.logger.error("webhook.unhandled", { error: String(err) });
      send(res, 500, "internal error");
    });
  });

  if (deps.onCallUpgrade) {
    server.on("upgrade", (req, socket, head) => {
      if ((req.url ?? "").split("?")[0] === "/phone/media/ws") {
        deps.onCallUpgrade?.(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, JSON.stringify({ ok: true }), "application/json");
    }
    if (req.method !== "POST" || path !== "/webhook") {
      return send(res, 404, "not found");
    }

    const headers = lowerHeaders(req.headers);
    const body = await readBody(req).catch(() => undefined);
    if (body === undefined) return send(res, 413, "payload too large");

    const provider = matchProvider(headers, providers ? [...providers] : undefined);
    if (!provider) {
      deps.logger.warn("webhook.no_provider", {});
      return send(res, 400, "unrecognized webhook source");
    }

    let verified = false;
    if (deps.config.gateway.requireSignature) {
      const secret = resolveProviderSecret(provider, deps.config, env);
      verified = await Promise.resolve(provider.verify({ body, headers, secret }));
      if (!verified) {
        deps.logger.warn("webhook.bad_signature", { provider: provider.name });
        return send(res, 401, "signature verification failed");
      }
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString("utf-8"));
    } catch {
      return send(res, 400, "invalid json");
    }

    const requestId = headers["x-inkbox-request-id"];
    if (!deps.dedup.begin(requestId)) {
      // Already seen/in-flight — ack so the sender stops retrying.
      return send(res, 200, JSON.stringify({ deduped: true }), "application/json");
    }

    const event: VerifiedEvent = {
      provider: provider.name,
      // The real verification outcome: true only when a signature was checked
      // and passed. With requireSignature off, events flow but stay unverified
      // so downstream can take the cautious path.
      verified,
      eventType: typeof parsed.event_type === "string" ? parsed.event_type : undefined,
      requestId,
      body: parsed,
      headers,
    };

    try {
      const ok = await deps.onEvent(event);
      if (ok === false) {
        deps.dedup.rollback(requestId);
        return send(res, 500, "dispatch failed");
      }
      deps.dedup.commit(requestId);
      return send(res, 200, JSON.stringify({ ok: true }), "application/json");
    } catch (err) {
      deps.dedup.rollback(requestId);
      deps.logger.error("webhook.dispatch_error", { error: String(err) });
      return send(res, 500, "dispatch error");
    }
  }

  return {
    server,
    listen(host, port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          deps.logger.info("webhook.listening", { host, port });
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function lowerHeaders(h: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(",");
  }
  return out;
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}
