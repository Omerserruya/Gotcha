/**
 * Marketing by opt-out (Omer's decision, 2026-10-08; docs/product/
 * ai-studio-skills-automations.md §6):
 *   - every marketing message carries a removal line, in its text (on
 *     WhatsApp, in the template's text, not a button: the reply is wanted)
 *   - a reply of "הסר" / "STOP" (and close variants) opts the customer out of
 *     marketing on that channel, for good, with a short confirmation
 *   - an opt-out always wins over any consent
 *
 * No imports: services deep-import this file
 * (`@chatcenter/shared/src/lib/marketing-optout`).
 */

export const REMOVAL_LINE = { he: "להסרה השיבו הסר", en: "Reply STOP to unsubscribe" } as const;

export const OPT_OUT_CONFIRMATION = {
  he: "הוסרת מרשימת התפוצה. לא נשלח לך עוד הודעות שיווקיות.",
  en: "You're unsubscribed. We won't send you marketing messages again.",
} as const;

const HEBREW = /[֐-׿]/;

/**
 * The whole message, not a word inside it: "הסר את המוצר מההזמנה" is a
 * request about an order, not an unsubscribe.
 */
const KEYWORDS = new Set([
  "הסר", "הסירו", "הסרה", "להסרה", "הסר אותי", "הסירו אותי", "תסיר אותי", "תסירו אותי", "הסירו אותי מהרשימה",
  "stop", "stop all", "unsubscribe", "remove me", "opt out", "optout",
]);

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The language of an opt-out reply ("he" / "en"), or null when the message is not one. */
export function optOutReply(text: string | null | undefined): "he" | "en" | null {
  if (!text) return null;
  const n = normalize(text);
  if (!n || n.length > 40 || !KEYWORDS.has(n)) return null;
  return HEBREW.test(n) ? "he" : "en";
}

/** Does this text already carry a removal line (either language)? */
export function hasRemovalLine(text: string | null | undefined): boolean {
  const n = normalize(String(text ?? ""));
  return n.includes(normalize(REMOVAL_LINE.he)) || n.includes(normalize(REMOVAL_LINE.en));
}

/** The removal line in the text's own language. */
export function removalLineFor(text: string | null | undefined): string {
  return HEBREW.test(String(text ?? "")) ? REMOVAL_LINE.he : REMOVAL_LINE.en;
}

/** The text with its removal line (added once, after a blank line). */
export function withRemovalLine(text: string): string {
  if (hasRemovalLine(text)) return text;
  return `${text.replace(/\s+$/, "")}\n\n${removalLineFor(text)}`;
}

/** Is this contact opted out on this channel? (Values are compared without case.) */
export function isOptedOutOn(optOutChannels: unknown, channel: string | null | undefined): boolean {
  if (!channel || !Array.isArray(optOutChannels)) return false;
  const c = String(channel).toUpperCase();
  return optOutChannels.some((x) => String(x).toUpperCase() === c);
}
