import type { OpencodeClient } from "@opencode-ai/sdk";
import { OpencodeClient as NativeClient } from "@opencode-ai/sdk/v2/client";

export interface NativePermissionInventory {
  list(directory: string, signal: AbortSignal): Promise<unknown[]>;
}

// The host supplies its authenticated v1 client, whose public API predates the
// permission inventory. Reuse that exact transport through the published v2
// constructor; never synthesize another URL, fetch implementation or identity.
// This single read-only compatibility boundary is validated, not mutated.
export function createNativePermissionInventory(client: OpencodeClient): NativePermissionInventory {
  return {
    async list(directory, signal) {
      const transport = (client as unknown as { _client?: unknown })._client as
        | { get?: unknown; getConfig?: unknown }
        | undefined;
      if (typeof transport?.get !== "function" || typeof transport.getConfig !== "function")
        throw new Error("Native permission inventory transport is unavailable.");
      const native = new NativeClient({ client: transport as never });
      const result = await native.permission.list({ directory }, { signal });
      if (result.error || !Array.isArray(result.data))
        throw new Error("Native permission inventory was not confirmed.");
      if (
        result.data.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            typeof row.id !== "string" ||
            !row.id ||
            typeof row.sessionID !== "string" ||
            !row.sessionID,
        )
      )
        throw new Error("Native permission inventory request shape is unsupported.");
      return result.data;
    },
  };
}
