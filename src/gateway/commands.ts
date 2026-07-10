import type { OpencodeClient } from "@opencode-ai/sdk";
import type { InkboxRuntime } from "../client.js";
import type { GatewayLogger, SessionManager } from "./types.js";

export interface CommandDeps {
  opencode: OpencodeClient;
  inkbox: InkboxRuntime;
  sessions: SessionManager;
  logger: GatewayLogger;
  directory: string;
  // Health probe (reachability + channels + tunnel), wired by the orchestrator.
  health(): Promise<Record<string, unknown>>;
}

// Whole-message control commands texted by the human. Returns the reply text
// to send back, or null when the message is not a command (so it flows to a
// normal turn). Commands are recognized only as the ENTIRE message.
// A command may offer a follow-up: `resume` carries the ordered session ids
// the next numeric reply selects from.
export interface CommandResult {
  reply: string;
  resume?: string[];
}

export async function handleCommand(
  deps: CommandDeps,
  chatKey: string,
  message: string,
): Promise<string | CommandResult | null> {
  const cmd = message.trim().toLowerCase();
  if (!cmd.startsWith("/")) return null;
  const word = cmd.split(/\s+/)[0];

  switch (word) {
    case "/clear":
    case "/new":
      await deps.sessions.resetSession(chatKey);
      return "Started a fresh conversation. What's next?";
    case "/stop":
    case "/cancel": {
      const aborted = await deps.sessions.abortTurn(chatKey);
      return aborted ? "Stopped." : "Nothing was running.";
    }
    case "/status": {
      const s = deps.sessions.status(chatKey);
      return s.busy ? "Working on your last message." : "Idle — send me something.";
    }
    case "/health": {
      const h = await deps.health().catch((err) => ({ ok: false, error: String(err) }));
      return formatHealth(h);
    }
    case "/usage":
      return usageReport(deps, chatKey);
    case "/resume":
      return resumeList(deps);
    default:
      return `Unknown command ${word}. Try /clear, /stop, /status, /health, or /usage.`;
  }
}

function formatHealth(h: Record<string, unknown>): string {
  const ok = h.ok === true;
  const lines = [ok ? "Healthy." : "Problems detected."];
  for (const [k, v] of Object.entries(h)) {
    if (k === "ok") continue;
    lines.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join("\n");
}

async function resumeList(deps: CommandDeps): Promise<string | CommandResult> {
  try {
    const res = await deps.opencode.session.list({ query: { directory: deps.directory } });
    const list = ((res as any)?.data ?? res ?? []) as Array<{ id: string; title?: string }>;
    const recent = list.slice(0, 5);
    if (recent.length === 0) return "No recent conversations.";
    return {
      reply: [
        "Recent conversations (reply with a number to resume):",
        ...recent.map((s, i) => `${i + 1}. ${s.title ?? s.id}`),
      ].join("\n"),
      resume: recent.map((s) => s.id),
    };
  } catch (err) {
    deps.logger.warn("command.resume_failed", { error: String(err) });
    return "Couldn't list recent conversations.";
  }
}

// /usage: provider-aware. With a subscription-authenticated provider the true
// analog is the subscription's rate-limit windows; for API-key providers we
// report per-session token/cost aggregates from the session's messages and
// say so, rather than implying window semantics that do not exist.
async function usageReport(deps: CommandDeps, chatKey: string): Promise<string> {
  const sessionID = deps.sessions.status(chatKey).sessionID;
  if (!sessionID) return "No usage yet — we haven't talked in this conversation.";
  try {
    const res = await deps.opencode.session.messages({
      path: { id: sessionID },
      query: { directory: deps.directory },
    });
    const messages = ((res as any)?.data ?? res ?? []) as Array<any>;
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const m of messages) {
      const t = m?.info?.tokens ?? m?.tokens;
      if (t) {
        input += Number(t.input ?? 0) || 0;
        output += Number(t.output ?? 0) || 0;
      }
      cost += Number(m?.info?.cost ?? m?.cost ?? 0) || 0;
    }
    const costLine = cost > 0 ? ` · ~$${cost.toFixed(2)}` : "";
    return `This conversation: ${input} in / ${output} out tokens${costLine}.`;
  } catch (err) {
    deps.logger.warn("command.usage_failed", { error: String(err) });
    return "Couldn't read usage for this conversation.";
  }
}
