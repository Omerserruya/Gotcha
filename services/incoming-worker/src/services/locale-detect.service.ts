/**
 * First-inbound language detection.
 *
 * Strategy:
 *   1. Cheap heuristic on character ranges — Hebrew has a dedicated
 *      Unicode block (U+0590..U+05FF), so any Hebrew letter in the text
 *      flips to "he". Otherwise default to "en". ~95% accurate for
 *      he/en on messages of ≥3 words, no external calls.
 *   2. (Future) LLM fallback for low-confidence cases — very short
 *      messages, emoji-only, mixed scripts. Wire OPENAI_API_KEY +
 *      a 1-token language-detect prompt when needed. Today's two-
 *      locale catalog (en/he) is well-served by the heuristic alone.
 *
 * The output is stored ONCE per conversation on `Conversation.detectedLocale`
 * — subsequent inbounds skip detection. Use `resolveConversationLocale`
 * from `@chatcenter/shared` to read it.
 */

import { prisma } from "@chatcenter/shared";

const HEBREW_RE = /[֐-׿]/;

export type DetectedLocale = "he" | "en";

export function detectLocaleHeuristic(text: string | null | undefined): {
  locale: DetectedLocale;
  confidence: "high" | "low";
} {
  const clean = (text ?? "").trim();
  if (!clean) return { locale: "en", confidence: "low" };
  if (HEBREW_RE.test(clean)) return { locale: "he", confidence: "high" };
  // Very short messages with no Hebrew may still be Hebrew transliteration
  // ("ken", "lo", "toda"). Mark as low confidence so a future LLM fallback
  // can re-evaluate.
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  return { locale: "en", confidence: wordCount >= 3 ? "high" : "low" };
}

/**
 * Set `detectedLocale` on the conversation if it isn't already set. Idempotent
 * — a second call on the same conversation is a no-op. Safe to fire-and-forget
 * from the message-create path; failures are logged and swallowed.
 */
export async function recordDetectedLocaleIfMissing(args: {
  conversationId: string;
  text: string | null | undefined;
}): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { detectedLocale: true },
    });
    if (!conv) return;
    if (conv.detectedLocale) return; // already detected
    const { locale } = detectLocaleHeuristic(args.text);
    await prisma.conversation.update({
      where: { id: args.conversationId },
      data: { detectedLocale: locale },
    });
  } catch (err) {
    console.warn(
      "[locale-detect] failed:",
      (err as { message?: string })?.message ?? err,
    );
  }
}
