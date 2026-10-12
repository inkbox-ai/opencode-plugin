import { Service } from "@opencode/client/service";
import type { ResolvedConfig } from "../config.js";
import { createV2Host } from "../host/v2-client.js";
import { createV2Connection } from "../host/v2-connection.js";
import { type EnsuredServer, resolveOpencodeBin } from "./serve.js";
import { hostMajor } from "./wrappers.js";

export async function connectV2Server(
  config: ResolvedConfig,
  start: boolean,
): Promise<EnsuredServer | undefined> {
  const explicit = config.gateway.serverUrl;
  if (!explicit && hostMajor(resolveOpencodeBin(config.gateway.serve.bin)) !== 2) return undefined;
  if (explicit) {
    const response = await fetch(new URL("/api/info", explicit), {
      signal: AbortSignal.timeout(3000),
      headers: {
        ...(process.env.INKBOX_OPENCODE_SERVER_PASSWORD
          ? {
              authorization: `Basic ${Buffer.from(`${process.env.INKBOX_OPENCODE_SERVER_USERNAME ?? "opencode"}:${process.env.INKBOX_OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
            }
          : {}),
      },
    }).catch(() => undefined);
    if (!response) return undefined;
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "OpenCode server authentication failed. Check INKBOX_OPENCODE_SERVER_PASSWORD.",
      );
    const info = (await response.json().catch(() => undefined)) as { version?: string } | undefined;
    if (!response.ok || !info?.version?.startsWith("2.")) return undefined;
  }
  const endpoint = explicit
    ? undefined
    : ((await Service.discover({ version: (v) => v.startsWith("2.") })) ??
      (start
        ? await Service.ensure({
            version: (v) => v.startsWith("2."),
            command: [resolveOpencodeBin(config.gateway.serve.bin), "serve", "--service"],
          })
        : undefined));
  const url = explicit ?? endpoint?.url;
  if (!url) return undefined;
  return {
    url,
    owned: false,
    client: createV2Host(
      createV2Connection(
        explicit,
        undefined,
        start && !explicit
          ? [resolveOpencodeBin(config.gateway.serve.bin), "serve", "--service"]
          : undefined,
      ),
      config,
    ),
    onExit() {},
    async stop() {},
  };
}
