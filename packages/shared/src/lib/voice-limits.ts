/**
 * The learned brand voice (BusinessProfile.observedVoice): the per-field caps
 * the learner trims to (services/ai brand-voice.stage VoiceSchema) and the
 * longest text its renderer (renderObservedVoice) can produce from them.
 *
 * The voice editor (auth PUT /api/workspace/voice) accepts up to
 * VOICE_RENDERED_MAX, so a learned voice always saves back unchanged. They
 * drifted once: the editor allowed 1800 for the whole text while the guidance
 * alone could be 1800. services/ai __tests__/voice-limits-contract.test.ts
 * pins the learner's caps and the renderer to these numbers.
 */
export const VOICE_LIMITS = {
  summary: 300,
  guidance: 1800,
  example: 600,
  situation: 300,
  situationCount: 6,
  emojiCount: 10,
  emoji: 16,
} as const;

/** Fixed text the renderer adds around the parts (the emoji sentence, the situations header, a label per rule). */
const EMOJI_LINE_TEXT = 120;
const SITUATIONS_HEADER = 80;
const SITUATION_LABEL = 40;

export const VOICE_RENDERED_MAX =
  VOICE_LIMITS.summary + 2 +
  VOICE_LIMITS.guidance + 1 +
  EMOJI_LINE_TEXT + VOICE_LIMITS.emojiCount * (VOICE_LIMITS.emoji + 1) + 2 +
  SITUATIONS_HEADER +
  VOICE_LIMITS.situationCount * (SITUATION_LABEL + VOICE_LIMITS.situation + 1);

export const VOICE_EDIT_MIN = 40;

/** The editor's check on a (trimmed, non-empty) voice: null when it may be saved, else the message. */
export function voiceEditError(text: string): string | null {
  const n = text.trim().length;
  return n < VOICE_EDIT_MIN || n > VOICE_RENDERED_MAX
    ? `guidance must be between ${VOICE_EDIT_MIN} and ${VOICE_RENDERED_MAX} characters`
    : null;
}
