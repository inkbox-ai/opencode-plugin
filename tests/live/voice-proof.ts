export function normalizedVoiceTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function containsVoiceMarker(value: string, marker: string): boolean {
  const haystack = normalizedVoiceTokens(value);
  const needle = normalizedVoiceTokens(marker);
  if (needle.length === 0 || haystack.length < needle.length) return false;
  return haystack.some((_, index) =>
    needle.every((token, offset) => haystack[index + offset] === token),
  );
}

// Diagnostics must distinguish a missing row from a misheard/reordered marker
// without exposing message bodies or call transcripts in public CI logs.
export function voiceMarkerEvidence(values: string[], marker: string) {
  const expected = new Set(normalizedVoiceTokens(marker));
  return {
    rows: values.length,
    exactMarkerRows: values.filter((value) => containsVoiceMarker(value, marker)).length,
    maxMatchedWords: Math.max(
      0,
      ...values.map(
        (value) =>
          new Set(normalizedVoiceTokens(value).filter((token) => expected.has(token))).size,
      ),
    ),
  };
}

export function hasAfterCallSmsIntent(value: string): boolean {
  const normalized = normalizedVoiceTokens(value).join(" ");
  const afterCall =
    /\bafter (?:we |you |i )?hang up\b/.test(normalized) ||
    /\b(?:after|when|once) (?:this |the )?call (?:ends|is over)\b/.test(normalized);
  return afterCall && hasSmsIntent(normalized);
}

export function hasSmsIntent(value: string): boolean {
  const normalized = normalizedVoiceTokens(value).join(" ");
  return (
    /\bsend\b.{0,80}\b(?:sms|text(?: message)?)\b/.test(normalized) ||
    /\b(?:text|sms) (?:me|the caller|the user|them|him|her)\b/.test(normalized)
  );
}

export function wasAcceptedForDelivery(message: {
  deliveryStatus?: unknown;
  delivery_status?: unknown;
}): boolean {
  const status = String(message.deliveryStatus ?? message.delivery_status ?? "").toLowerCase();
  return status !== "blocked_spam_filter";
}
