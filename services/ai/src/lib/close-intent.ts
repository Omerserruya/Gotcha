/**
 * May the bot close this conversation now? (Supervisor 2026-11-15, eval A05:
 * "יש גרביים?" answered "out of stock", then the model called
 * close_conversation, and the customer's "מתי יחזרו למלאי?" landed on a
 * CLOSED conversation and was never answered. gpt-6-luna "low" did it 9 times.)
 *
 * The model may close only when the customer's latest message is an explicit
 * end (thanks, bye, that's all) after the bot already answered something. A
 * question, a new need, a long message or a first message never counts.
 * Idle closes are the automation's, not the model's, and never come here.
 */

/** Phrases that end a conversation, matched on a normalized message. */
const END_PHRASES: RegExp[] = [
  // Hebrew
  /תודה/, /תודות/, /ביי/, /להתראות/, /^זהו$/, /זהו זה/, /זה הכל/, /זה הכול/, /זה מה שרציתי/,
  /אין צורך/, /לא צריך יותר/, /לא צריך עוד/, /הכל ברור/, /הכול ברור/, /יום טוב/, /ערב טוב/,
  /לילה טוב/, /שבת שלום/, /סבבה תודה/,
  // English
  /\bthanks?\b/, /\bthank you\b/, /\bthx\b/, /\bty\b/, /\bbye\b/, /\bgoodbye\b/, /\bthat'?s all\b/,
  /\bthat'?s it\b/, /\bnothing else\b/, /\ball good\b/, /\bhave a (good|nice|great) day\b/,
  // Arabic
  /شكرا/, /شكراً/, /مع السلامة/, /باي/,
];

/** Words that open a new need: the customer is not done. */
const NEW_NEED: RegExp[] = [
  /אבל/, /עוד שאלה/, /שאלה נוספת/, /רציתי לשאול/, /אפשר/, /איך/, /מתי/, /כמה/, /למה/, /האם/, /איפה/, /יש לכם/,
  /\bbut\b/, /\balso\b/, /\banother\b/, /\bhow\b/, /\bwhen\b/, /\bwhere\b/, /\bcan (you|i)\b/, /\bcould\b/, /\bdo you\b/,
  /لكن/, /متى/, /كيف/, /هل/,
];

export const MAX_END_WORDS = 8;

export interface CloseVerdict { allowed: boolean; reason?: "no_reply_yet" | "question" | "new_need" | "too_long" | "not_an_end" }

/**
 * `latest` is the customer's latest message; `botRepliesBefore` counts the
 * bot's replies earlier in the conversation (the need was answered at least once).
 */
export function closeAllowed(latest: string, botRepliesBefore: number): CloseVerdict {
  if (botRepliesBefore < 1) return { allowed: false, reason: "no_reply_yet" };
  const text = String(latest ?? "").trim();
  if (/[?؟]/.test(text)) return { allowed: false, reason: "question" };
  const norm = text.toLowerCase().replace(/[’׳]/g, "'").replace(/[!.,:;"()״-]+/g, " ").replace(/\s+/g, " ").trim();
  if (NEW_NEED.some((re) => re.test(norm))) return { allowed: false, reason: "new_need" };
  if (norm.split(" ").filter(Boolean).length > MAX_END_WORDS) return { allowed: false, reason: "too_long" };
  if (!END_PHRASES.some((re) => re.test(norm))) return { allowed: false, reason: "not_an_end" };
  return { allowed: true };
}

/** The tool result the model sees when its close is refused: answer and continue. */
export function closeRefusal(v: CloseVerdict): string {
  return JSON.stringify({
    ok: false,
    error: "close_not_allowed",
    reason: v.reason,
    instruction:
      "Do NOT close this conversation. The customer has not ended it (an explicit thanks, bye or that's all after their need was met). " +
      "Answer their latest message and keep the conversation open.",
  });
}
