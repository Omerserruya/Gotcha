/**
 * Grounded post-execution customer messages.
 *
 * Every customer-facing message that follows a verified tool execution
 * (approval continuations, proactive completion updates) flows through ONE
 * pipeline: model generation → humanizeReply (style/no AI-signature) →
 * validateGroundedMessage (facts must survive) → deterministic fallback when
 * the generated text contradicts or omits a critical verified field.
 *
 * The validator never "improves" wording; it only decides whether the message
 * is safe to send. The fallback is boring on purpose: built directly from the
 * structured execution result, it can state nothing the provider didn't
 * confirm.
 */

const HEBREW_RE = /[֐-׿]/;

/** Structured, provider-verified facts about one executed business action. */
export interface ExecutionFacts {
  tool: string;
  /**
   * "rejected" is a first-class outcome, not a flavour of failure: the action
   * was DECLINED by a human, so nothing was attempted and nothing broke. The
   * customer is owed a different sentence ("this was not approved") than for a
   * dispatch that ran and failed, and conflating the two either invents a
   * technical problem that never happened or hides a human decision.
   */
  outcome: "succeeded" | "failed" | "rejected";
  /** Human order name, e.g. "#1004" (leading # optional). */
  orderName?: string | null;
  /** Money amount CONFIRMED by the provider - never the requested amount. */
  amount?: number | null;
  currency?: string | null;
  /**
   * Verified business status: "cancelled" | "refunded" | "processed" |
   * "pending" | free-form provider status. "pending" is load-bearing: the
   * message must never present a pending refund as completed money movement.
   */
  status?: string | null;
  /** Safe short failure reason (already sanitized) when outcome=failed. */
  errorReason?: string | null;
}

export interface GroundedVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Internal reason CLASSES, and the plain sentence each becomes.
 *
 * The classes are an engineering vocabulary. One of them ("unknown") reached a
 * live customer as `(סיבה: unknown)` because the raw token was handed to the
 * model as a "verified fact" and the model faithfully printed it. A customer
 * must never see one of these strings, so the token is translated before
 * generation and the validator below refuses any message a token survives in.
 */
export const REASON_PHRASES: Record<string, { he: string; en: string }> = {
  not_possible_after_shipping: {
    he: "ההזמנה כבר נמסרה לטיפול המשלוח",
    en: "the order has already been handed over for shipping",
  },
  already_done: { he: "הפעולה כבר בוצעה קודם", en: "this had already been done" },
  not_permitted: { he: "אין לי הרשאה לבצע את זה", en: "I am not permitted to do this" },
  provider_unavailable: {
    he: "המערכת של החנות לא זמינה כרגע",
    en: "the store system is not responding right now",
  },
  exceeds_limit: { he: "הסכום גבוה מהמותר", en: "the amount is above what is allowed" },
  unknown: { he: "", en: "" },
};

/** Tokens that identify our internals. None may appear in customer text. */
const INTERNAL_TOKEN_RE = new RegExp(
  `\\b(${Object.keys(REASON_PHRASES).join("|")}|shopify_\\d{3}|cancel_rejected|order_not_cancellable|cancel_not_applied)\\b`,
  "i",
);

/** The customer-facing phrase for a reason class, or "" when there is none. */
export function reasonPhrase(reason: string | null | undefined, he: boolean): string {
  const entry = REASON_PHRASES[String(reason ?? "").toLowerCase()];
  if (!entry) return "";
  return he ? entry.he : entry.en;
}

// Completion claims that contradict a PENDING status (money not moved yet) or
// a FAILED outcome. Deliberately coarse: a false positive costs us the boring
// fallback; a false negative tells a customer money moved when it didn't.
const COMPLETION_RE =
  /(הוחזר|זוכה|זיכינו|קיבלת את ה|הכסף (הועבר|חזר)|ההחזר (בוצע|הושלם)|בוצע בהצלחה|הושלם בהצלחה|(was|has been|is now) (processed|completed|refunded)|money (is|was) (back|returned)|successfully (refunded|processed|completed)|(processed|completed) successfully)/i;
const SUCCESS_RE =
  /(בהצלחה|הושלם|בוצע|ביטלתי|טופל|הוסדר|success|succeed|completed|done|has been (cancelled|canceled|refunded)|was (cancelled|canceled|refunded))/i;
const WIDE_DASH_RE = /[–—―]/;

/** Every digit-run in the text, normalized (strips thousands separators). */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, ""));
}

function amountForms(amount: number): string[] {
  const fixed = amount.toFixed(2);
  const trimmed = String(amount);
  const noDecimals = String(Math.trunc(amount));
  return Array.from(new Set([fixed, trimmed, noDecimals]));
}

/**
 * Decide whether a generated message is safe to send, given the verified
 * facts. Pure and deterministic - the regression suite runs it directly.
 */
export function validateGroundedMessage(message: string, facts: ExecutionFacts): GroundedVerdict {
  const problems: string[] = [];
  const text = message?.trim() ?? "";
  if (!text) return { ok: false, problems: ["empty_message"] };

  // 1. AI-signature punctuation. humanizeReply strips these; if one survived,
  // the message did not go through the shared style layer.
  if (WIDE_DASH_RE.test(text)) problems.push("em_dash_present");

  // 2. An action that did not happen must never read as success. Rejection is
  // held to the SAME bar as failure: "your cancellation is done" is equally
  // false whether Shopify refused or a manager did.
  if ((facts.outcome === "failed" || facts.outcome === "rejected") && SUCCESS_RE.test(text)) {
    problems.push(
      facts.outcome === "rejected" ? "rejection_presented_as_success" : "failure_presented_as_success",
    );
  }

  // 2b. No internal vocabulary. A reason CLASS or a provider status code in
  // the text means the model echoed a field meant for us, not for them.
  if (INTERNAL_TOKEN_RE.test(text)) problems.push("internal_reason_leaked");

  // 3. A pending refund must never read as completed money movement.
  if (facts.outcome === "succeeded" && facts.status === "pending" && COMPLETION_RE.test(text)) {
    problems.push("pending_presented_as_completed");
  }

  // 4. Confirmed amounts must appear, and no CONTRADICTING amount may appear.
  if (facts.outcome === "succeeded" && facts.amount != null) {
    const forms = amountForms(facts.amount);
    const present = forms.some((f) => text.includes(f));
    if (!present) problems.push("amount_missing");
    const orderDigits = (facts.orderName ?? "").replace(/\D/g, "");
    const foreign = numbersIn(text).filter(
      (n) => !forms.some((f) => n === f || Number(n) === Number(f)) && n !== orderDigits,
    );
    if (foreign.length) problems.push("contradicting_number_present");
  }

  // 5. Order references must not contradict the verified order.
  if (facts.orderName) {
    const digits = facts.orderName.replace(/\D/g, "");
    const orderRefs = text.match(/#\s?(\d{2,})/g) ?? [];
    if (orderRefs.some((r) => r.replace(/\D/g, "") !== digits)) {
      problems.push("wrong_order_reference");
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Deterministic, provider-grounded message - the guaranteed-safe path when
 * generation fails validation (or the model is unavailable). Plain
 * punctuation only; Hebrew when the customer writes Hebrew.
 */
export function buildFallbackMessage(facts: ExecutionFacts, inboundSample: string): string {
  const he = HEBREW_RE.test(inboundSample);
  const order = facts.orderName ? (facts.orderName.startsWith("#") ? facts.orderName : `#${facts.orderName}`) : null;
  const money =
    facts.amount != null ? `${facts.amount.toFixed(2)} ${facts.currency ?? ""}`.trim() : null;

  const isRefund = /refund/.test(facts.tool);
  const isCancel = /cancel/.test(facts.tool);

  // The action in the customer's words. Used by the non-success branches so
  // they name what did not happen instead of saying "the action" at someone
  // who asked to cancel an order.
  const actionHe = isCancel ? "הביטול" : isRefund ? "ההחזר" : "הפעולה";
  const actionEn = isCancel ? "the cancellation" : isRefund ? "the refund" : "the action";

  // DECLINED BY A HUMAN. Nothing was attempted, so there is no fault to report
  // and nothing to retry - say plainly that it was not approved, state that the
  // order is therefore unchanged, and keep the conversation open.
  if (facts.outcome === "rejected") {
    const subjectHe = isCancel ? "ההזמנה לא בוטלה" : isRefund ? "הכסף לא הוחזר" : "לא ביצענו את הפעולה";
    return he
      ? `הבקשה ל${actionHe.replace(/^ה/, "")} לא אושרה ולכן ${subjectHe}. אפשר לבדוק יחד אפשרות אחרת.`
      : `Your request for ${actionEn} was not approved, so ${
          isCancel ? "the order was not cancelled" : isRefund ? "no money was returned" : "no change was made"
        }. We can look at another option together.`;
  }

  // APPROVED, DISPATCHED, DID NOT HAPPEN. Two things must be true at once: do
  // not claim success, and do not promise a person is already working on it -
  // no task, ticket or notification exists at this point, and claiming one is
  // exactly the unsupported promise the quality contract forbids.
  if (facts.outcome === "failed") {
    const why = reasonPhrase(facts.errorReason, he);
    return he
      ? `הבקשה אושרה, אבל לא הצלחתי להשלים את ${actionHe} כרגע${why ? ` כי ${why}` : ""}. אני בודק את האפשרויות ואם לא אצליח אעביר אותך לנציג.`
      : `Your request was approved, but I was not able to complete ${actionEn} right now${why ? ` because ${why}` : ""}. I am checking the options, and if I cannot resolve it I will pass you to a colleague.`;
  }

  if (isRefund && facts.status === "pending") {
    return he
      ? `בקשת ההחזר${money ? ` על סך ${money}` : ""}${order ? ` עבור הזמנה ${order}` : ""} התקבלה ונמצאת בטיפול מול חברת הסליקה. נעדכן אותך ברגע שההחזר יושלם.`
      : `Your refund request${money ? ` for ${money}` : ""}${order ? ` on order ${order}` : ""} was submitted and is pending with the payment provider. We will update you once it completes.`;
  }
  if (isRefund) {
    return he
      ? `ההחזר${money ? ` על סך ${money}` : ""}${order ? ` עבור הזמנה ${order}` : ""} בוצע בהצלחה.`
      : `Your refund${money ? ` of ${money}` : ""}${order ? ` for order ${order}` : ""} was processed successfully.`;
  }
  if (isCancel) {
    return he
      ? `ההזמנה${order ? ` ${order}` : ""} בוטלה בהצלחה.`
      : `Your order${order ? ` ${order}` : ""} was cancelled successfully.`;
  }
  return he ? "הפעולה שביקשת הושלמה בהצלחה." : "The action you requested was completed successfully.";
}
