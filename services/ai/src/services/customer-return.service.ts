/**
 * The customer will come back to us (Smoovee prod 2026-11-13, conv
 * cmweyp0940r1wkdj39ue69ui0): "נתכתב בעזרת השם ביום ראשון" got "נשאר רק
 * לדעת איזו שעה ביום ראשון נוחה לך?", then "9 בבוקר" got "אין לנו אפשרות
 * לתאם זמן מכאן". Nothing used the hour. The follow-up flow pins an hour for a
 * message WE send, but here the customer said THEY will write.
 *
 * Omer: the right answer is a short warm acknowledgement, no question and no
 * gathering of a time ("אין בעיה, נשמח לעמוד לרשותך בראשון").
 *
 * Not this: asking us to come back to them ("תחזרו אליי מחר", "call me at 3").
 * That is a follow-up we schedule, and the follow-up flow keeps it.
 */

/** The customer says they will be the one to write or call again. */
const RETURN_MARKERS = [
  "נתכתב", "נדבר", "נהיה בקשר", "אחזור אליכם", "אחזור אליך", "אני אחזור", "אחזור בהמשך",
  "אעדכן אתכם", "אעדכן אותך", "אעדכן אותכם", "אכתוב לכם", "אכתוב לך", "אצור קשר", "ניצור קשר", "אחזור אליכן",
  "i'll get back to you", "i will get back to you", "talk soon", "we'll talk", "talk later",
  "i'll be in touch", "i will be in touch", "speak soon", "i'll write", "i'll let you know",
];

/** ...unless they ask US to do it. */
const ASKS_US_MARKERS = [
  "תחזרו", "תחזור אלי", "תחזרי אלי", "תתקשרו", "תתקשר", "תתקשרי", "להתקשר אלי", "לחזור אלי",
  "תזכרו אותי", "תזכירו לי", "תזכיר לי", "תכתבו לי", "תשלחו לי",
  "call me", "remind me", "text me", "get back to me", "ring me", "message me", "contact me",
];

export function customerWillReturn(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  if (ASKS_US_MARKERS.some((m) => t.includes(m))) return false;
  return RETURN_MARKERS.some((m) => t.includes(m));
}

const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** "ביום ראשון" / "בראשון" / "מחר" in the customer's words, for the acknowledgement; null when none. */
export function returnWhenHe(text: string | null | undefined): string | null {
  const t = String(text ?? "");
  const day = new RegExp(`(?:ביום\\s+|(?<![\\u0590-\\u05FF])ב)(${HE_DAYS.join("|")})(?![\\u0590-\\u05FF])`).exec(t);
  if (day) return `ב${day[1]}`;
  if (/(?<![֐-׿])מחרתיים(?![֐-׿])/.test(t)) return "מחרתיים";
  if (/(?<![֐-׿])מחר(?![֐-׿])/.test(t)) return "מחר";
  if (/(?<![֐-׿])בשבוע הבא(?![֐-׿])/.test(t)) return "בשבוע הבא";
  return null;
}

/** The turn's instruction: acknowledge, nothing else. */
export function returnAcknowledgementCorrective(lang: "he" | "en"): string {
  return (
    "**The customer said THEY will get back to you later. Nothing is missing.** " +
    "Rewrite your reply as ONE short, warm acknowledgement in the customer's language" +
    (lang === "he" ? ' (for example "אין בעיה, נשמח לעמוד לרשותך בראשון")' : ' (for example "No problem, we\'ll be here whenever you\'re ready")') +
    ". No question at all. Do not ask for a time, an hour, a phone number or any other detail, " +
    "do not schedule anything and do not offer to pass them to the team."
  );
}

/** Does the reply ask the customer anything? */
export function replyAsks(reply: string | null | undefined): boolean {
  return /[?؟]/.test(String(reply ?? ""));
}

/**
 * The reply with every sentence that asks something removed, or the short
 * acknowledgement when nothing is left. Used only when the model still asked
 * after one regeneration.
 */
export function acknowledgementOnly(reply: string, lang: "he" | "en", customerText: string): string {
  const kept = reply
    .split(/(?<=[.!?؟\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !/[?؟]/.test(s))
    .join(" ")
    .trim();
  if (kept.replace(/[^\p{L}]/gu, "").length >= 4) return kept;
  if (lang === "en") return "No problem, we'll be here whenever you're ready.";
  const when = returnWhenHe(customerText);
  return `אין בעיה, נשמח לעמוד לרשותך${when ? ` ${when}` : ""}.`;
}
