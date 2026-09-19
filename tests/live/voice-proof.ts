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

export function hostedCallerReadiness(driverCaller: string, autCaller: string, marker: string) {
  const driverCallerReady =
    hasAfterCallSmsIntent(driverCaller) && containsVoiceMarker(driverCaller, marker);
  const autCallerReady = hasAfterCallSmsIntent(autCaller) && containsVoiceMarker(autCaller, marker);
  return {
    callerReady: driverCallerReady && autCallerReady,
    driverCallerReady,
    autCallerReady,
  };
}

export function hostedReadbackReadiness(autSpeech: string, driverHeard: string, marker: string) {
  const autReadbackReady = containsVoiceMarker(autSpeech, marker);
  const driverReadbackReady = containsVoiceMarker(driverHeard, marker);
  return {
    autReadbackReady,
    driverReadbackReady,
    readbackReady: autReadbackReady && driverReadbackReady,
  };
}

export function hasSmsIntent(value: string): boolean {
  const normalized = normalizedVoiceTokens(value)
    .join(" ")
    .replace(/\bs m s\b/g, "sms");
  return (
    /\bsend\b.{0,80}\b(?:sms|text(?: message)?)\b/.test(normalized) ||
    /\b(?:text|sms) (?:me|the caller|the user|them|him|her)\b/.test(normalized)
  );
}

export function smsIntentEvidence(values: string[]) {
  const normalized = values.map((value) => normalizedVoiceTokens(value).join(" "));
  return {
    rows: values.length,
    sendVerbRows: normalized.filter((value) => /\bsend\b/.test(value)).length,
    smsRows: normalized.filter((value) => /\bsms\b/.test(value)).length,
    spelledSmsRows: normalized.filter((value) => /\bs m s\b/.test(value)).length,
    textRows: normalized.filter((value) => /\btext\b/.test(value)).length,
    recognizedRows: values.filter(hasSmsIntent).length,
    maxWords: Math.max(0, ...values.map((value) => normalizedVoiceTokens(value).length)),
  };
}

export function wasAcceptedForDelivery(message: {
  deliveryStatus?: unknown;
  delivery_status?: unknown;
}): boolean {
  const status = String(message.deliveryStatus ?? message.delivery_status ?? "").toLowerCase();
  return status !== "blocked_spam_filter";
}

// Delivery proof concerns the whole message, not a marker embedded in prose.
// Count every accepted fresh outbound message so a wrong-body duplicate cannot
// disappear from the one-send invariant.
export function hostedSmsDeliveryEvidence(
  messages: Array<{
    id: string;
    text?: string | null;
    remotePhoneNumber?: string | null;
    recipients?: Array<{ recipientPhoneNumber?: string | null }> | null;
    createdAt?: Date | string | null;
    deliveryStatus?: unknown;
    delivery_status?: unknown;
  }>,
  marker: string,
  endedAt: Date | string | null | undefined,
  successfulProviderIds: string[],
  expectedTarget: string,
) {
  const accepted = messages.filter(wasAcceptedForDelivery);
  const expected = normalizedVoiceTokens(marker).join(" ");
  const target = expectedTarget.replace(/\D/g, "");
  const exactTargetRows = accepted.filter((message) => {
    const targets = new Set(
      [
        message.remotePhoneNumber,
        ...(message.recipients ?? []).map((row) => row.recipientPhoneNumber),
      ]
        .map((value) => String(value ?? "").replace(/\D/g, ""))
        .filter(Boolean),
    );
    return target && targets.size === 1 && targets.has(target);
  }).length;
  const endedMs = endedAt instanceof Date ? endedAt.getTime() : Date.parse(endedAt ?? "");
  const exactBodyRows = accepted.filter(
    (message) => expected && normalizedVoiceTokens(message.text ?? "").join(" ") === expected,
  ).length;
  const postCallRows = accepted.filter((message) => {
    const sentMs =
      message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : Date.parse(message.createdAt ?? "");
    return Number.isFinite(endedMs) && Number.isFinite(sentMs) && sentMs >= endedMs;
  }).length;
  const journalMatchedRows = accepted.filter((message) =>
    successfulProviderIds.includes(message.id),
  ).length;
  return {
    acceptedRows: accepted.length,
    exactTargetRows,
    exactBodyRows,
    postCallRows,
    journalMatchedRows,
    complete:
      accepted.length === 1 &&
      exactTargetRows === 1 &&
      exactBodyRows === 1 &&
      postCallRows === 1 &&
      journalMatchedRows === 1,
  };
}
