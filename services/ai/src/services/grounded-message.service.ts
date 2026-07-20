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
  outcome: "succeeded" | "failed";
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

  // 2. A failed action must never read as success.
  if (facts.outcome === "failed" && SUCCESS_RE.test(text)) {
    problems.push("failure_presented_as_success");
  }

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

  if (facts.outcome === "failed") {
    return he
      ? "לא הצלחנו להשלים את הפעולה שביקשת. נציג מהצוות ממשיך לטפל בזה ויעדכן אותך בהקדם."
      : "We were not able to complete the action you asked for. A member of our team is on it and will update you shortly.";
  }

  const isRefund = /refund/.test(facts.tool);
  const isCancel = /cancel/.test(facts.tool);

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
