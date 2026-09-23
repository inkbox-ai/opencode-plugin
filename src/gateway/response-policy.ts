import type { ResolvedGatewayConfig } from "../config.js";
import type { CompanionTurn } from "./companion.js";

export function mentionsAgent(text: string, handle = ""): boolean {
  const body = text.replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  return [...new Set(["agent", handle.trim().replace(/^@/, "")])].some((token) => {
    if (!token) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w@.+-])@${escaped}(?![\\w-])(?!\\.\\w)`, "i").test(body);
  });
}

export function sameAuthor(channel: string, left: string, right: string): boolean {
  return channel === "email" || channel === "mail"
    ? left.trim().toLowerCase() === right.trim().toLowerCase()
    : left === right;
}

export function controlText(text: string, handle = ""): string {
  const parts = text.trim().split(/\s+/);
  const first = parts[0].toLowerCase().replace(/[,:]+$/, "");
  return ["@agent", `@${handle.replace(/^@/, "").toLowerCase()}`].includes(first)
    ? parts.slice(1).join(" ")
    : text;
}

export function companionWakes(c: CompanionTurn, config: ResolvedGatewayConfig): boolean {
  if (config.companionResponseMode !== "relaxed" && c.senderAccess !== "direct") return false;
  if (config.groupReplyMode !== "mention" || mentionsAgent(c.rawText ?? "", c.handle)) return true;
  const email = c.emailAddress?.trim().toLowerCase();
  return Boolean(
    c.metadata.channel === "mail" &&
      email &&
      c.toAddresses?.some((recipient) => {
        const address = recipient.match(/<([^<>]+)>/)?.[1] ?? recipient;
        return address.trim().toLowerCase() === email;
      }),
  );
}

export function isPermissionReply(text: string): boolean {
  return /^(?:[123]|y|yes|ok|okay|approve|allow|sure|go|go ahead|always|allow always|yes always|n|no|deny|reject|decline)$/i.test(
    text.trim(),
  );
}
