export const PHONE_VOICE_STACKS = ["inkbox_voice_ai", "openai_realtime", "inkbox_tts_stt"] as const;

export type PhoneVoiceStack = (typeof PHONE_VOICE_STACKS)[number];
export type VoiceAiAuthorityMode = "contact_scoped" | "yolo";

export function isPhoneVoiceStack(value: unknown): value is PhoneVoiceStack {
  return typeof value === "string" && PHONE_VOICE_STACKS.includes(value as PhoneVoiceStack);
}
