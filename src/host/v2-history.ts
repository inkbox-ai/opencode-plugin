import type { SessionMessageInfo } from "@opencode/client";
import type { V2Client } from "./v2-connection.js";

export async function readHistory(
  client: V2Client,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await client.message.list(
      { sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" as const }) },
      { signal },
    );
    if (!page.data.length) break;
    messages.push(...page.data);
    const next = page.cursor.next;
    if (!next) break;
    if (seen.has(next)) throw new Error("OpenCode history pagination did not advance.");
    seen.add(next);
    cursor = next;
  }
  return messages;
}

export function normalizeHistory(messages: SessionMessageInfo[], sessionID: string) {
  return projectHistory(messages, sessionID).messages;
}

export function projectHistory(messages: SessionMessageInfo[], sessionID: string) {
  let parentID: string | undefined;
  let ambiguous = false;
  let inputs: string[] = [];
  let canStart = true;
  const projected = messages.flatMap((message): any[] => {
    if (message.type === "idle") {
      const failed = message.outcome !== "succeeded" ? inputs : [];
      canStart = true;
      parentID = undefined;
      inputs = [];
      ambiguous = false;
      return failed.map((input) => ({
        info: {
          id: `${message.id}_${input}`,
          sessionID,
          role: "assistant",
          parentID: input,
          finish: "error",
          error: { message: `OpenCode session ${message.outcome}.` },
        },
        parts: [],
      }));
    }
    if (message.type === "user") {
      ambiguous = !canStart && inputs.length > 0;
      parentID = ambiguous ? undefined : message.id;
      inputs = ambiguous ? [...inputs, message.id] : [message.id];
      canStart = false;
      return [
        {
          info: {
            id: message.id,
            sessionID,
            role: "user",
            parentID,
            sourceAmbiguous: ambiguous,
            time: message.time,
          },
          parts: [{ type: "text", text: message.text }],
        },
      ];
    }
    if (["synthetic", "shell", "skill", "compaction"].includes(message.type) && canStart) {
      parentID = undefined;
      inputs = [];
      ambiguous = false;
      canStart = false;
    }
    if (message.type !== "assistant") return [];
    const parts = message.content.map((part): any => {
      if (part.type !== "tool") return part;
      const state = part.state as any;
      return {
        type: "tool",
        tool: part.name,
        callID: part.id,
        state: {
          ...state,
          status: state.status === "streaming" ? "pending" : state.status,
          input: state.input,
          output:
            state.content
              ?.filter((content: any) => content.type === "text")
              .map((content: any) => content.text)
              .join("\n") ??
            state.result?.content ??
            state.output,
        },
      };
    });
    if (message.finish && !["tool-calls", "unknown"].includes(message.finish)) canStart = true;
    return [
      {
        info: { ...message, sessionID, role: "assistant", parentID, sourceAmbiguous: ambiguous },
        parts,
      },
    ];
  });
  return { messages: projected, parentID, ambiguous };
}
