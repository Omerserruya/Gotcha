/**
 * Twin of services/ai/src/__tests__/helpers/hebrew-house-rules.ts; keep the two in step.
 *
 * The house rules for Hebrew copy, as a sweep a test runs over every string it
 * adds (2026-10-08, the Hebrew sweep):
 *   - no em or en dash (it reads as AI)
 *   - a one-letter prefix (מ ב ל ה ו ש כ) takes a hyphen only before Latin
 *     letters or digits: "ב-Shopify", "בחנות", never "ב-חנות" or "בShopify"
 *   - GOTCHA is feminine: never a masculine verb right after its name
 *   - the reader is not addressed in a gender: no "אתה", no masculine
 *     imperative of the common verbs
 * Returns every violation, so a failing test names the string and the rule.
 */
const MASCULINE_AFTER_GOTCHA = /GOTCHA (יכול|יוצר|שולח|מעדכן|בודק|מציג|מחפש|קורא|כותב|מוצא|מוכן|משתמש|רואה)(?![\u0590-\u05FF])/;
const MASCULINE_FIRST_PERSON = /(^|[^\u0590-\u05FF])אני (יכול|יוצר|שולח|מעדכן|בודק|מציג|מחפש|קורא|כותב|מוצא|מוכן|משתמש)(?![\u0590-\u05FF])/;
const ADDRESSED_AS_MAN = /(^|[^\u0590-\u05FF])(אתה|ראה|בחר|לחץ|הזן|שלח|עדכן)(?![\u0590-\u05FF])/;

export function hebrewHouseRuleViolations(label: string, text: string): string[] {
  const out: string[] = [];
  if (/[\u2013\u2014\u2015]/.test(text)) out.push(`${label}: a dash in "${text}"`);
  if (/(^|[^\u0590-\u05FF])[מבלהושכ]-[\u0590-\u05FF]/.test(text)) out.push(`${label}: a hyphen before a Hebrew word in "${text}"`);
  if (/(^|[^\u0590-\u05FFA-Za-z])[מבלהושכ][A-Za-z0-9]/.test(text)) out.push(`${label}: no hyphen before Latin or a digit in "${text}"`);
  if (MASCULINE_AFTER_GOTCHA.test(text)) out.push(`${label}: GOTCHA with a masculine verb in "${text}"`);
  if (MASCULINE_FIRST_PERSON.test(text)) out.push(`${label}: a masculine first person in "${text}"`);
  if (ADDRESSED_AS_MAN.test(text)) out.push(`${label}: the reader addressed as a man in "${text}"`);
  if (!/[\u0590-\u05FF]/.test(text)) out.push(`${label}: no Hebrew at all in "${text}"`);
  return out;
}
