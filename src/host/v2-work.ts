import type { V2Client } from "./v2-connection.js";
import { readHistory } from "./v2-history.js";

export async function nativeWork(
  client: V2Client,
  root: string,
  directory: string,
  received = new Set<string>(),
) {
  const ids = new Set([root]);
  for (const parentID of ids) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.session.list({
        parentID,
        directory,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const session of page.data) ids.add(session.id);
      if (ids.size > 4096) throw new Error("OpenCode child capacity exceeded.");
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("OpenCode child pagination failed.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  const active = await client.session.active();
  const shells = (await client.shell.list({ location: { directory } })).data.filter(
    (shell) => shell.status === "running" && ids.has(String(shell.metadata?.sessionID)),
  );
  let notifications = 0,
    queued = 0;
  for (const id of ids) {
    const pending = new Set<string>();
    const key = (metadata: any) =>
      metadata?.source === "shell"
        ? `shell:${metadata.shellID}`
        : metadata?.source === "subagent"
          ? `subagent:${metadata.childID}`
          : undefined;
    for (const message of await readHistory(client, id)) {
      if (message.type === "assistant")
        for (const part of message.content) {
          if (part.type !== "tool" || part.state.status !== "completed") continue;
          const state = part.state as any;
          if (
            part.name === "shell" &&
            state.metadata?.shellID &&
            state.content?.some(
              (item: any) =>
                item.type === "text" &&
                item.text.startsWith("Command moved to the background (shell ID:"),
            )
          )
            pending.add(`shell:${state.metadata.shellID}`);
          if (
            part.name === "subagent" &&
            state.metadata?.status === "running" &&
            state.metadata.sessionID
          )
            pending.add(`subagent:${state.metadata.sessionID}`);
        }
      if (message.type === "synthetic") {
        const value = key(message.metadata);
        if (value) pending.delete(value);
      }
    }
    const inbox = await client.session.inbox.list({ sessionID: id });
    for (const item of inbox) {
      const value = key((item.payload as any)?.metadata);
      if (value) received.add(value);
    }
    notifications += [...pending].filter((value) => !received.has(value)).length;
    queued += inbox.length;
  }
  return {
    ids,
    shells,
    busy: Boolean(shells.length || notifications || queued || [...ids].some((id) => active[id])),
  };
}

export async function waitNativeWork(
  client: V2Client,
  root: string,
  directory: string,
  signal?: AbortSignal,
) {
  while ((await nativeWork(client, root, directory)).busy) {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
