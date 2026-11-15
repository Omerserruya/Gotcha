/**
 * The bot never asks for payment-card details and never writes them down.
 *
 * Smoovee prod 2026-11-15 06:44 (cmwhgsog): a customer whose payment went
 * through without an order was asked "לציין את ארבע הספרות האחרונות של
 * הכרטיס?", answered with them, and the digits went into the escalation
 * summary ("ארבע ספרות אחרונות כרטיס: ...") and the tool's stored args. No
 * tool of ours reads card digits: an order is found by its number, or by the
 * customer's own phone and email.
 *
 * Two deterministic guards, after the model:
 *  - stripCardAsk: a reply sentence that asks for (or repeats) card details is
 *    dropped; when nothing is left, the reply asks for the order number or the
 *    name and phone instead.
 *  - redactCardDetails: card digits in any text we store or hand on (tool
 *    args, so an escalation's reason and summary) are masked.
 */

// "credit" alone is a store credit and "card" alone a product card: only a payment card counts.
const CARD = "(?:כרטיס(?:\\s+ה?אשראי)?|אשראי|ויזה|מאסטרקארד|(?:credit|debit|payment|bank)\\s+card|card\\s+(?:number|ending|details)|visa|mastercard|amex)";
// Not "מספר" alone: "שילמתי באשראי, מה מספר ההזמנה?" is about an order. "מספר הכרטיס" is below.
const DETAIL = "(?:ספרות|הספרות|תוקף|cvv|cvc|קוד\\s+(?:ה)?אבטחה|digits?|expiry|expiration|security\\s+code)";

/** "the last four digits" is always a card's here: no tool of ours takes the last digits of anything. */
const LAST_DIGITS = "(?:(?:4|ארבע)\\s+(?:ה)?ספרות\\s+(?:ה)?אחרונות|(?:ה)?ספרות\\s+(?:ה)?אחרונות|last\\s+(?:4|four)(?:\\s+digits)?)";
/** A sentence about the customer's card details (its number, last digits, expiry, CVV). */
const CARD_DETAIL_RE = new RegExp(`${CARD}[^.!?؟\\n]{0,40}${DETAIL}|${DETAIL}[^.!?؟\\n]{0,40}${CARD}|${LAST_DIGITS}|מספר\\s+(?:ה)?כרטיס|\\bcard\\s+(?:number|ending|details)\\b|\\b(?:cvv|cvc)\\b`, "iu");

export const PAYMENT_CHECK_LINE = {
  he: "כדי לבדוק את התשלום, אפשר לשלוח את מספר ההזמנה, או את השם והטלפון שאיתם בוצעה?",
  en: "To check the payment, could you send the order number, or the name and phone the order was placed with?",
} as const;

export function mentionsCardDetails(text: string | null | undefined): boolean {
  return CARD_DETAIL_RE.test(String(text ?? ""));
}

/** The reply without any sentence about card details; the payment line when nothing else is left. */
export function stripCardAsk(text: string, locale: "he" | "en"): string {
  if (!mentionsCardDetails(text)) return text;
  const parts = text.match(/[^.!?؟\n]+[.!?؟]*\s*|\n+/gu) ?? [text];
  const kept = parts.filter((p) => !mentionsCardDetails(p)).join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return kept.replace(/^[,;:\s]+/, "").length >= 3 ? kept : PAYMENT_CHECK_LINE[locale];
}

/** Card digits masked: a full card number, and digits written next to a card word. */
export function redactCardDetails(text: string): string {
  let out = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[card number removed]");
  // Digits right after a card word or "the last four digits" (never an order
  // number: "מספר הזמנה 97112" names no card).
  const near = new RegExp(`(${CARD}[^\\n\\d]{0,40}|${LAST_DIGITS}[^\\n\\d]{0,40}|${DETAIL}[^\\n\\d]{0,40})(\\d{3,4})(?!\\d)`, "giu");
  out = out.replace(near, (m, pre: string, digits: string) =>
    new RegExp(`${CARD}|${LAST_DIGITS}`, "iu").test(pre) ? `${pre}${"*".repeat(digits.length)}` : m);
  // ...and digits written before them ("4155 זה הספרות האחרונות של כרטיס האשראי").
  const before = new RegExp(`(?<!\\d)(\\d{3,4})(?!\\d)(?=[^\\n\\d]{0,20}(?:${LAST_DIGITS}|${CARD}))`, "giu");
  out = out.replace(before, (d) => "*".repeat(d.length));
  return out;
}

/** Every string in a tool's args, redacted (one level of nesting, as tool args are). */
export function redactCardDetailsInArgs<T extends Record<string, unknown>>(args: T): T {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = redactCardDetails(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? redactCardDetails(x) : x));
    else if (v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([kk, vv]) => [kk, typeof vv === "string" ? redactCardDetails(vv) : vv]));
    else out[k] = v;
  }
  return out as T;
}
