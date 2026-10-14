import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

export type V2Client = ReturnType<typeof OpenCode.make>;
export interface V2Connection {
  get(): Promise<V2Client>;
  invalidate(): void;
}

export function createV2Connection(
  url?: string,
  headers?: RequestInit["headers"],
  startCommand?: string[],
): V2Connection {
  let pending: Promise<V2Client> | undefined;
  return {
    invalidate() {
      pending = undefined;
    },
    get() {
      pending ??= (async () => {
        if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function")
          throw new Error("The OpenCode V2 gateway requires Node.js 22 or newer.");
        const endpoint = url
          ? undefined
          : ((await Service.discover({ version: (v) => v.startsWith("2.") })) ??
            (startCommand
              ? await Service.ensure({ version: (v) => v.startsWith("2."), command: startCommand })
              : undefined));
        const baseUrl = url ?? endpoint?.url;
        if (!baseUrl)
          throw Object.assign(
            new Error("OpenCode V2 service is unavailable. Start OpenCode and retry."),
            { code: "ECONNREFUSED" },
          );
        const client = OpenCode.make({
          baseUrl,
          headers: headers ?? (endpoint ? Service.headers(endpoint) : explicitHeaders()),
        });
        const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
        if (!info.version.startsWith("2.")) throw new Error("Expected an OpenCode V2 server.");
        return client;
      })().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
  };
}

function explicitHeaders(): Record<string, string> {
  const password = process.env.INKBOX_OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.INKBOX_OPENCODE_SERVER_USERNAME ?? "opencode";
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}
