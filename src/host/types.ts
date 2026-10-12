import type { OpencodeClient } from "@opencode-ai/sdk";

export type HostClient = {
  session: Pick<
    OpencodeClient["session"],
    | "create"
    | "get"
    | "list"
    | "messages"
    | "message"
    | "prompt"
    | "promptAsync"
    | "abort"
    | "status"
    | "delete"
  >;
  config: Pick<OpencodeClient["config"], "get">;
  tool: Pick<OpencodeClient["tool"], "ids">;
  event: Pick<OpencodeClient["event"], "subscribe">;
  postSessionIdPermissionsPermissionId: OpencodeClient["postSessionIdPermissionsPermissionId"];
  protocol?: 2;
  permissionInventory?(directory: string, signal: AbortSignal): Promise<unknown[]>;
  ready?(directory: string): Promise<void>;
};
