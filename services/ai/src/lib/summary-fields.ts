/**
 * The conversation summary, as a card shows it.
 *
 * The stored summary (openai.provider summarizer, also read by the CRM
 * writeback and the conversation service's situation) is markdown bullets
 * with English labels: "• **Why they reached out**: …". A Hebrew card
 * showed the English scaffolding and the raw ** (2026-10-08). The labels
 * become the turn's words; the content stays as written (the summarizer
 * already writes it in the conversation's language), without markdown or
 * wide dashes.
 */
import { withoutWideDashes } from "./wide-dash";

type Locale = "he" | "en";

const SECTIONS: Array<{ key: string; match: RegExp; label: Record<Locale, string> }> = [
  { key: "reason", match: /^why they reached out$/i, label: { he: "למה פנו", en: "Why they reached out" } },
  { key: "asked", match: /^what they asked$/i, label: { he: "מה שאלו", en: "What they asked" } },
  { key: "status", match: /^status$/i, label: { he: "איפה זה עומד", en: "Where it stands" } },
  { key: "opportunity", match: /^opportunity$/i, label: { he: "הזדמנות", en: "Opportunity" } },
];

const plain = (s: string) => withoutWideDashes(s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim());

/** The summary's sections in the turn's words, or one plain field when it is not the bullet shape. */
export function summaryFields(summary: string, locale: Locale): Array<{ key: string; label: string; value: string }> {
  const out: Array<{ key: string; label: string; value: string }> = [];
  for (const m of summary.matchAll(/\*\*([^*]+)\*\*\s*:\s*([\s\S]*?)(?=(?:\n\s*)?(?:[•*-]\s*)?\*\*[^*]+\*\*\s*:|$)/g)) {
    const section = SECTIONS.find((s) => s.match.test(m[1]!.trim()));
    const value = plain(m[2]!.replace(/^[•\s]+|[•\s]+$/g, ""));
    if (section && value) out.push({ key: `summary_${section.key}`, label: section.label[locale], value: value.slice(0, 400) });
  }
  if (out.length) return out;
  const text = plain(summary.replace(/^\s*[•*-]\s*/gm, ""));
  return text ? [{ key: "summary", label: locale === "he" ? "סיכום" : "Summary", value: text.slice(0, 600) }] : [];
}
