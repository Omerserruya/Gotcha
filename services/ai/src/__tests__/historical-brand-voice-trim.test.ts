/**
 * Prod GOTCHA 2026-11-10: "guidance: String must contain at most 1800
 * character(s)". A guidance a little over its cap failed the parse (and the
 * retry), and the whole learned voice was thrown away. Over-long fields are now
 * cut at the last whole line / sentence that fits; the prompt states the limits.
 */
import { describe, it, expect } from "vitest";
import { VoiceSchema, trimToBoundary, VOICE_SYSTEM_PROMPT, GUIDANCE_MAX, GUIDANCE_ASK } from "../services/historical-intelligence/brand-voice.stage";

const line = (i: number) => `- Rule ${i}: open with היי and the customer's first name, keep replies short and warm.`;
const base = { summary: "Short, warm, emoji-light replies.", emojiPalette: ["🙂"], greetingExample: "היי!", closingExample: "תודה!" };

describe("an over-long voice is trimmed, not thrown away", () => {
  it("★ a 2600-character guidance parses, cut at the last whole line under the cap", () => {
    const guidance = Array.from({ length: 30 }, (_, i) => line(i + 1)).join("\n");
    expect(guidance.length).toBeGreaterThan(GUIDANCE_MAX);
    const r = VoiceSchema.safeParse({ ...base, guidance });
    expect(r.success).toBe(true);
    const g = (r as any).data.guidance as string;
    expect(g.length).toBeLessThanOrEqual(GUIDANCE_MAX);
    expect(g.split("\n").every((l) => /^- Rule \d+: .*warm\.$/.test(l))).toBe(true);
    expect(guidance.startsWith(g)).toBe(true);
  });

  it("an over-long summary and situation rule are trimmed at a sentence, the rest kept", () => {
    const long = "They answer fast. ".repeat(30);
    const r = VoiceSchema.safeParse({ ...base, summary: long, guidance: line(1) + "\n" + line(2), situations: { price: long, shipping: "Give the date." } });
    expect(r.success).toBe(true);
    const d = (r as any).data;
    expect(d.summary.length).toBeLessThanOrEqual(300);
    expect(d.summary.endsWith("fast.")).toBe(true);
    expect(d.situations.price.length).toBeLessThanOrEqual(300);
    expect(d.situations.shipping).toBe("Give the date.");
  });

  it("more than 10 emoji keep the first 10", () => {
    const r = VoiceSchema.safeParse({ ...base, guidance: line(1), emojiPalette: Array.from({ length: 14 }, (_, i) => String(i)) });
    expect((r as any).data.emojiPalette).toHaveLength(10);
  });

  it("still a real gate: a guidance under 40 characters fails, a missing one fails", () => {
    expect(VoiceSchema.safeParse({ ...base, guidance: "- be nice" }).success).toBe(false);
    expect(VoiceSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("the prompt states the guidance limit below the cap", () => {
    expect(GUIDANCE_ASK).toBeLessThan(GUIDANCE_MAX);
    expect(VOICE_SYSTEM_PROMPT).toContain(`under ${GUIDANCE_ASK} characters`);
  });
});

describe("trimToBoundary", () => {
  it("line, then sentence, then word; never longer than max; short and non-strings untouched", () => {
    expect(trimToBoundary("aaaa\nbbbb\ncccc", 12)).toBe("aaaa\nbbbb");
    expect(trimToBoundary("One two three. Four five six seven", 22)).toBe("One two three.");
    // never cut below half the cap to reach a boundary: falls through to a word
    expect(trimToBoundary("One two. Three four five six", 20)).toBe("One two. Three four");
    expect(trimToBoundary("alpha beta gamma delta", 15)).toBe("alpha beta");
    expect(trimToBoundary("  short  ", 100)).toBe("short");
    expect(trimToBoundary(42, 5)).toBe(42);
    expect(String(trimToBoundary("x".repeat(50), 10)).length).toBe(10);
  });
});
