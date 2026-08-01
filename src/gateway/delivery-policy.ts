export type DeliveryFailureClassification = "retryable" | "terminal" | "unknown";

const terminal = [
  "not opted in",
  "opted out",
  "invalid number",
  "invalid phone",
  "unreachable",
  "blocked",
  "unsafe",
  "harmful",
  "abusive",
  "threat",
  "illegal content",
];
const retryable = [
  "40002",
  "spam",
  "content policy",
  "content rejected",
  "content violation",
  "too_long",
  "too long",
  "markdown",
  "emoji",
  "profanity",
];

export function classifyDeliveryFailure(value: unknown): DeliveryFailureClassification {
  const text = (value instanceof Error ? value.message : String(value ?? "")).toLowerCase();
  if (terminal.some((marker) => text.includes(marker))) return "terminal";
  if (retryable.some((marker) => text.includes(marker))) return "retryable";
  return "unknown";
}

interface Attempt {
  count: number;
  at: number;
}
let attempts = new Map<string, Attempt>();
const TTL = 30 * 60 * 1000;

export function deliveryFailureKey(
  channel: string,
  target?: string,
  conversationId?: string,
): string | undefined {
  const conversation = conversationId?.trim().toLowerCase();
  if (conversation) return `${channel}:conversation:${conversation}`;
  const raw = target?.trim().toLowerCase();
  const digits = channel === "email" ? undefined : raw?.replace(/\D/g, "");
  const normalized = channel === "email" ? raw : digits || raw;
  return normalized ? `${channel}:target:${normalized}` : undefined;
}

export function clearDeliveryFailures(key: string | undefined): void {
  if (key) attempts.delete(key);
}

export interface FailureRecovery {
  attempt: number;
  classification: DeliveryFailureClassification;
  prompt?: string;
  mandatory: boolean;
}

export function deliveryFailureRecovery(params: {
  key?: string;
  channel: string;
  target?: string;
  failure: unknown;
  failedBody?: string;
  now?: number;
}): FailureRecovery {
  const classification = classifyDeliveryFailure(params.failure);
  if (!params.key) return { attempt: 0, classification, mandatory: false };
  const now = params.now ?? Date.now();
  const previous = attempts.get(params.key);
  const count = previous && now - previous.at <= TTL ? previous.count + 1 : 1;
  attempts.set(params.key, { count, at: now });
  if (count >= 3) return { attempt: count, classification, mandatory: false };
  const body = (params.failedBody ?? "").trim().slice(0, 400);
  const header =
    `[inkbox:delivery_failure channel=${params.channel} attempt=${count}/3` +
    `${params.target ? ` to=${params.target}` : ""}]`;
  if (classification === "retryable" && count === 1) {
    return {
      attempt: count,
      classification,
      mandatory: true,
      prompt: [
        header,
        `Your outbound ${params.channel} message was not delivered: ${String(params.failure)}`,
        body ? `Undelivered message:\n«${body}»` : undefined,
        `This is both the first failure and a retryable failure. You MUST send exactly one safe, materially corrected ${params.channel} message now. Do not reuse the failed wording. Do not return [SILENT], skip the correction, or defer it.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  const policy =
    classification === "terminal"
      ? "Do not retry this destination or content."
      : classification === "retryable"
        ? "The mandatory first correction also failed. You may make one final materially different safe attempt, or stop."
        : "Retry only if a review shows it is safe and unlikely to duplicate a committed send.";
  return {
    attempt: count,
    classification,
    mandatory: false,
    prompt: [
      header,
      `Your outbound ${params.channel} message was not delivered: ${String(params.failure)}`,
      body ? `Undelivered message:\n«${body}»` : undefined,
      `${policy} If you do not make a permitted recovery, reply exactly [SILENT].`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function resetDeliveryPolicyForTest(): void {
  attempts = new Map();
}
