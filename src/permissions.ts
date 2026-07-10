import type { ToolContext } from "@opencode-ai/plugin";
import type { ResolvedConfig } from "./config.js";

// Normalize for comparison: lower-case + trim. Phone numbers must already
// be in E.164 in both the allowlist and the input.
function norm(s: string): string {
  return s.trim().toLowerCase();
}

// Check a single outbound recipient against the allowlist. Returns the
// reason string when blocked, or null when allowed. An unset/empty list
// applies no filtering.
export function checkOutboundRecipient(
  recipient: string,
  allowed: string[] | undefined,
): string | null {
  if (!allowed || allowed.length === 0) return null;
  const wanted = norm(recipient);
  const hit = allowed.some((entry) => norm(entry) === wanted);
  return hit ? null : `Recipient ${recipient} is not on the outbound allowlist.`;
}

// Check a batch of outbound recipients. Returns the first blocking reason,
// or null if every recipient passes.
export function checkOutboundRecipients(
  recipients: string[],
  allowed: string[] | undefined,
): string | null {
  for (const r of recipients) {
    const block = checkOutboundRecipient(r, allowed);
    if (block) return block;
  }
  return null;
}

export interface OutboundRequest {
  // Tool name, used as the permission id so users can persist an
  // "always allow" rule per tool.
  tool: string;
  // Every address/number the message will reach (to + cc + bcc).
  recipients: string[];
  // Permission patterns the host displays and persists "always" rules
  // against. Defaults to recipients; conversation-addressed sends pass a
  // synthetic pattern instead (they have no explicit recipient list).
  patterns?: string[];
  // One-line human summary shown in the approval prompt.
  summary: string;
  metadata?: Record<string, unknown>;
}

// Gate an outbound send. Always enforces the recipient allowlist when one is
// configured; in "ask" mode additionally requests approval through opencode's
// permission system. The approval race has a timeout so headless runs (no
// client attached to answer) fail with actionable guidance instead of hanging.
export async function approveOutbound(
  ctx: ToolContext,
  config: ResolvedConfig,
  request: OutboundRequest,
): Promise<void> {
  const { allowedRecipients, approval, askTimeoutMs } = config.outbound;
  if (approval === "allowlist" && allowedRecipients.length === 0) {
    throw new Error(
      'outbound.approval is "allowlist" but outbound.allowedRecipients is empty, which would leave ' +
        'sends unguarded. Add recipients to the allowlist, or set approval to "ask" or "auto".',
    );
  }
  const block = checkOutboundRecipients(request.recipients, allowedRecipients);
  if (block) throw new Error(block);
  if (approval !== "ask") return;

  // The host treats an ask with no patterns as pre-approved — never send one.
  const patterns = (request.patterns ?? request.recipients).filter((p) => p.trim().length > 0);
  if (patterns.length === 0) {
    throw new Error(
      `${request.tool}: cannot request approval without at least one recipient or conversation pattern.`,
    );
  }

  const ask = ctx.ask({
    permission: request.tool,
    patterns,
    always: patterns,
    metadata: {
      summary: request.summary,
      recipients: request.recipients,
      ...(request.metadata ?? {}),
    },
  });
  // If the race is lost, the still-pending ask must not surface as an
  // unhandled rejection when the user later dismisses or denies it.
  ask.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      ask,
      new Promise<never>((_, reject) => {
        if (askTimeoutMs > 0) {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Outbound approval timed out after ${Math.round(askTimeoutMs / 1000)}s — nobody answered the ` +
                  `permission prompt. If the prompt is still visible, dismiss it (answering cannot revive this ` +
                  `call). For unattended runs, pre-approve via opencode's permission config, or set the plugin ` +
                  `option outbound.approval to "allowlist" with outbound.allowedRecipients.`,
              ),
            );
          }, askTimeoutMs);
          timer.unref?.();
        }
        if (ctx.abort) {
          onAbort = () =>
            reject(new Error("Tool call aborted while waiting for outbound approval."));
          if (ctx.abort.aborted) onAbort();
          else ctx.abort.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) ctx.abort?.removeEventListener("abort", onAbort);
  }
}
