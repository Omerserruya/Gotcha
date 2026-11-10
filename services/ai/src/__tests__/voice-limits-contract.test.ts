/**
 * The learner, its renderer and the voice editor share one set of limits
 * (packages/shared voice-limits). They drifted once: the editor allowed 1800
 * characters for the WHOLE voice while the guidance alone could be 1800, so a
 * learned voice opened in the editor and saved unchanged was refused.
 */
import { describe, it, expect } from "vitest";
import { VOICE_LIMITS, VOICE_RENDERED_MAX, voiceEditError } from "@chatcenter/shared";
import { VoiceSchema, renderObservedVoice, GUIDANCE_MAX } from "../services/historical-intelligence/brand-voice.stage";

const over = (n: number, unit = "word ") => unit.repeat(Math.ceil((n + 50) / unit.length));

/** The longest voice the learner can produce: every field over its cap, trimmed by the schema. */
function maximalVoice() {
  const situations = Object.fromEntries(["opening", "price", "out_of_stock", "shipping", "complaint", "closing"].map((k) => [k, over(VOICE_LIMITS.situation)]));
  const r = VoiceSchema.safeParse({
    summary: over(VOICE_LIMITS.summary),
    guidance: over(VOICE_LIMITS.guidance),
    emojiPalette: Array.from({ length: 14 }, () => "x".repeat(40)),
    greetingExample: over(VOICE_LIMITS.example),
    closingExample: over(VOICE_LIMITS.example),
    situations,
  });
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
}

describe("one set of voice limits", () => {
  it("★ the learner's caps are the shared ones", () => {
    const v = maximalVoice();
    expect(GUIDANCE_MAX).toBe(VOICE_LIMITS.guidance);
    expect(v.guidance.length).toBeLessThanOrEqual(VOICE_LIMITS.guidance);
    expect(v.guidance.length).toBeGreaterThan(VOICE_LIMITS.guidance - 10);
    expect(v.summary.length).toBeGreaterThan(VOICE_LIMITS.summary - 10);
    expect(v.emojiPalette).toHaveLength(VOICE_LIMITS.emojiCount);
    expect(v.emojiPalette.every((e) => e.length === VOICE_LIMITS.emoji)).toBe(true);
    expect(Object.values(v.situations).every((s: any) => s.length > VOICE_LIMITS.situation - 10 && s.length <= VOICE_LIMITS.situation)).toBe(true);
  });

  it("★ a maximal learned voice fits the editor and saves back unchanged", () => {
    const rendered = renderObservedVoice(maximalVoice());
    expect(rendered.length).toBeGreaterThan(1800); // the old editor cap refused this
    expect(rendered.length).toBeLessThanOrEqual(VOICE_RENDERED_MAX);
    expect(voiceEditError(rendered)).toBeNull();
  });

  it("the editor still refuses too short and too long", () => {
    expect(voiceEditError("too short")).toMatch(/between 40 and/);
    expect(voiceEditError("x".repeat(VOICE_RENDERED_MAX + 1))).toMatch(/between 40 and/);
    expect(voiceEditError("x".repeat(VOICE_RENDERED_MAX))).toBeNull();
  });
});
