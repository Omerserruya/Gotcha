/**
 * The gate that replaces "did this happen twice".
 *
 * The old pipeline decided what was worth keeping by counting: a question asked
 * once was deleted, a question asked twice survived. That filter answers the
 * wrong question. A business's most valuable knowledge is often asked rarely -
 * "do you ship to Eilat", "can I collect on a Saturday", "what happens if the
 * dress does not fit before the wedding" - and each of those is worth more than
 * the tenth repetition of "how much is delivery". Frequency measures how COMMON
 * something is, and the thing we actually need to know is whether it is
 * REUSABLE: would this help answer a different customer tomorrow?
 *
 * Reusability is a property of the text, so it can be judged from the text -
 * deterministically, on every candidate, at no cost, and with a reason a human
 * can read. That is what this module does. The model still proposes; this
 * decides, because the failure it guards against is the one the model is worst
 * at resisting: an answer that reads like policy but contains one customer's
 * order number, and is therefore false for everyone else.
 */

export type RejectReason =
  | "order-or-tracking-number"
  | "phone-number"
  | "email-address"
  | "specific-calendar-date"
  | "id-number"
  | "personal-address"
  | "one-off-scope"
  | "not-generalized"
  | "too-short";

export interface SpecificityVerdict {
  ok: boolean;
  reasons: RejectReason[];
  /** The exact substrings that triggered a rejection, for the review UI. */
  evidence: string[];
}

// ── Patterns ─────────────────────────────────────────────────
//
// Every pattern here targets a token that is true for ONE customer and false
// for everyone else. Numbers that express a RULE are deliberately not matched:
// "45 days", "3 business days", "20% off", "199 shekels" are all four digits or
// fewer and all survive, because a policy without its numbers is not a policy.

/** Five or more consecutive digits: order ids, tracking codes, card fragments. */
const LONG_DIGIT_RUN = /\d{5,}/g;

/** Israeli mobile/landline, with or without separators, and +972 form. */
const PHONE = /(?:\+972[-\s]?|\b0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}\b/g;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

/**
 * A date pinned to a calendar - 15/03, 3.4.26, 15-03-2026. The delivery that
 * arrives "on the 15th" is one order; the one that arrives "within 3 days" is
 * the policy. Written month names are left alone: "we are closed in August"
 * is a standing fact.
 */
const CALENDAR_DATE = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g;

/** Israeli ID / company number: exactly 9 digits, often written alone. */
const ID_NUMBER = /\b\d{9}\b/g;

/** Courier tracking formats (UPU S10 and the common Israel Post variants). */
const TRACKING_CODE = /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g;

/**
 * A street address with a house number. "רחוב הרצל 15", "Herzl St 15".
 * A city on its own is not matched - "we deliver to Eilat" is policy.
 */
const STREET_ADDRESS = /(?:רח['׳]?|רחוב|שד['׳]?|שדרות)\s+\S+\s+\d{1,4}\b/g;

const PATTERNS: Array<{ re: RegExp; reason: RejectReason }> = [
  { re: TRACKING_CODE, reason: "order-or-tracking-number" },
  { re: ID_NUMBER, reason: "id-number" },
  { re: PHONE, reason: "phone-number" },
  { re: EMAIL, reason: "email-address" },
  { re: STREET_ADDRESS, reason: "personal-address" },
  { re: CALENDAR_DATE, reason: "specific-calendar-date" },
  // Last, so a run that a more specific pattern already explained is reported
  // under that name rather than as an anonymous digit run.
  { re: LONG_DIGIT_RUN, reason: "order-or-tracking-number" },
];

/**
 * Is this candidate reusable for a customer who is not the one it came from?
 *
 * `scope` is the model's own classification and is trusted only to say NO:
 * an item it labelled ONE_OFF is dropped without further inspection, but an
 * item it labelled POLICY still has to survive every pattern above. The model
 * calling something reusable is an opinion; a tracking number in the text is a
 * fact.
 */
export function judgeSpecificity(item: {
  question: string;
  answer: string;
  scope?: string;
  generalized?: boolean;
}): SpecificityVerdict {
  const reasons: RejectReason[] = [];
  const evidence: string[] = [];

  const q = (item.question || "").trim();
  const a = (item.answer || "").trim();

  if (q.length < 5 || a.length < 5) {
    return { ok: false, reasons: ["too-short"], evidence: [] };
  }
  if (item.scope === "ONE_OFF") {
    reasons.push("one-off-scope");
  }
  if (item.generalized === false) {
    reasons.push("not-generalized");
  }

  const haystack = `${q}\n${a}`;
  for (const { re, reason } of PATTERNS) {
    // Fresh lastIndex per call - these are module-level /g regexes.
    re.lastIndex = 0;
    const found = haystack.match(re);
    if (found && found.length > 0) {
      if (!reasons.includes(reason)) reasons.push(reason);
      for (const f of found.slice(0, 3)) {
        if (!evidence.includes(f)) evidence.push(f);
      }
    }
  }

  return { ok: reasons.length === 0, reasons, evidence };
}

/**
 * Strip the specific tokens instead of discarding the item.
 *
 * Some genuinely good answers carry one stray number - "your order 10432 ships
 * Sunday, we always ship within two business days". Throwing that away loses
 * the policy along with the order id. Redaction keeps the sentence and removes
 * the part that was only ever true for one person, and the caller re-judges the
 * result: if what is left still reads like an answer, it is kept.
 */
export function redactSpecifics(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "…");
  }
  // Collapse the damage: "order … ships …" reads better than "order… ships…".
  return out.replace(/\s*…\s*/g, " … ").replace(/\s{2,}/g, " ").trim();
}
