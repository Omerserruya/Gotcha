/**
 * What actually happened this turn, as facts rather than as prose.
 *
 * The honesty net in `action-honesty.service.ts` has been widened four times in
 * one session, each round against a new phrasing of the same lie: "אעביר את
 * הבקשה לצוות", then "אעביר את המצב לצוות", then "אעביר את הפרטים לצוות", then
 * the passive "בקשתך עודכנה בהזמנה". The allowlist lost every round. Matching
 * the SHAPE of a promise rather than its nouns won the last one, and will lose
 * eventually too, because a regex over output can only ever describe the lies
 * somebody has already seen.
 *
 * The deeper problem is what "supported" meant. `turnHasExecutionEvidence`
 * answers "did ANY tool execute", so reading an order was evidence for "I have
 * changed your address". The claim and the evidence were never about the same
 * thing.
 *
 * This module makes them about the same thing. Every customer-facing tool
 * result is normalised into a fixed set of facts, and each claim shape names
 * the facts that would make it true:
 *
 *     "שיניתי את הכתובת"   requires shippingAddressUpdated
 *     "החלפתי את המידה"    requires exchangeCompleted
 *     "פתחתי החזרה"        requires returnCreated AND a returnId
 *     "פניתי לצוות"        requires a handoff, a task or a notification
 *
 * A paraphrase the regex has never seen still fails, because the facts do not
 * change when the wording does. The regex stays as the detector and as a last
 * line of defence; it is no longer the arbiter.
 */

// ─── The facts ──────────────────────────────────────────────

export interface CustomerOutcome {
  customerResolved: boolean;
  orderResolved: boolean;
  orderName: string | null;

  actionAttempted: boolean;
  actionSucceeded: boolean;

  orderCancelled: boolean;
  refundCreated: boolean;
  refundAmount: string | null;
  refundCurrency: string | null;
  remainingRefundableAmount: string | null;

  customerUpdated: boolean;
  shippingAddressUpdated: boolean;
  orderEdited: boolean;

  exchangeCompleted: boolean;
  oldVariant: string | null;
  newVariant: string | null;
  priceDifference: string | null;

  returnCreated: boolean;
  returnProvider: string | null;
  returnId: string | null;

  noteAdded: boolean;
  tagAdded: boolean;

  confirmationSent: boolean;
  invoiceSent: boolean;
  documentSent: boolean;
  documentType: string | null;
  deliveryChannel: string | null;

  notificationSent: boolean;
  taskCreated: boolean;
  handoffCreated: boolean;
  followUpScheduled: boolean;
  /** An approval is pending, and the system guarantees exactly one continuation. */
  approvalContinuationGuaranteed: boolean;

  trackingAvailable: boolean;
  inventoryKnown: boolean;

  safeFailureReason: string | null;
  supportedAlternatives: string[];
}

export function emptyOutcome(): CustomerOutcome {
  return {
    customerResolved: false,
    orderResolved: false,
    orderName: null,
    actionAttempted: false,
    actionSucceeded: false,
    orderCancelled: false,
    refundCreated: false,
    refundAmount: null,
    refundCurrency: null,
    remainingRefundableAmount: null,
    customerUpdated: false,
    shippingAddressUpdated: false,
    orderEdited: false,
    exchangeCompleted: false,
    oldVariant: null,
    newVariant: null,
    priceDifference: null,
    returnCreated: false,
    returnProvider: null,
    returnId: null,
    noteAdded: false,
    tagAdded: false,
    confirmationSent: false,
    invoiceSent: false,
    documentSent: false,
    documentType: null,
    deliveryChannel: null,
    notificationSent: false,
    taskCreated: false,
    handoffCreated: false,
    followUpScheduled: false,
    approvalContinuationGuaranteed: false,
    trackingAvailable: false,
    inventoryKnown: false,
    safeFailureReason: null,
    supportedAlternatives: [],
  };
}

export interface ToolCallRecord {
  tool?: string;
  result?: string;
  decision?: string;
  sideEffect?: string;
}

/**
 * The tool's own fields, whichever envelope it arrived in.
 *
 * There are two, and reading the wrong one costs a customer the truth. The
 * adapter path returns `{ ok, result }`; the catalog path returns
 * `{ ok, output, error }`. Live (2026-08-02): `add_order_note` wrote the note,
 * Shopify showed it, the ledger committed it - and the fact block said nothing
 * had happened, because `note_added` was one level down. The model read the
 * fact block and told the customer the note had not been added. A correct
 * mechanism reporting the inverse of the truth, which is worse than no
 * mechanism, because it is believed.
 *
 * `ok` and `error` stay at the top level where the envelope puts them.
 */
function parse(result: unknown): Record<string, any> {
  if (result == null) return {};
  let v: any = result;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (!v || typeof v !== "object") return {};
  const inner = v.result ?? v.output;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return { ...inner, ok: v.ok ?? inner.ok, error: v.error ?? v.reason ?? inner.error };
  }
  return v;
}

/** A tool that ran for real, as opposed to one a gate refused or parked. */
function reallyExecuted(t: ToolCallRecord): boolean {
  if (t.decision !== "executed" && t.decision !== "executed_on_retry") return false;
  return t.sideEffect !== "awaiting_approval" && t.sideEffect !== "denied";
}

function bareName(tool: string): string {
  const dot = tool.lastIndexOf(".");
  const name = dot >= 0 ? tool.slice(dot + 1) : tool;
  return name.replace(/^integration_/, "");
}

/**
 * Normalise ONE tool result onto the fact set.
 *
 * Every branch reads a field the tool genuinely returns and that the tool sets
 * only after its own read-back. `address_updated` is not "the PUT returned
 * 200"; it is "an independent GET of the order shows the new address". That is
 * what makes these facts worth resting a customer-facing claim on.
 */
export function applyToolResult(outcome: CustomerOutcome, record: ToolCallRecord): CustomerOutcome {
  const tool = String(record.tool ?? "");
  if (!tool || tool.startsWith("__")) return outcome;

  const o = { ...outcome };
  const name = bareName(tool);
  const r = parse(record.result);
  const executed = reallyExecuted(record);

  if (record.sideEffect === "awaiting_approval") {
    // Not a completed action, but it IS a real guarantee: the approval routes
    // produce exactly one continuation whichever way the decision goes, so
    // "I'll come back to you" is a promise the product keeps here.
    o.actionAttempted = true;
    o.approvalContinuationGuaranteed = true;
    return o;
  }

  if (!executed) return o;

  if (r.ok === false || r.error || r.reason) {
    o.actionAttempted = true;
    // `reason` as well as `error`: executeAdapterTool's failure shape is
    // `{ ok: false, reason }`, and reading only `error` loses why.
    const why = typeof r.error === "string" ? r.error : typeof r.reason === "string" ? r.reason : null;
    if (why && !o.safeFailureReason) o.safeFailureReason = why;
    return o;
  }

  if (r.customer_id || r.customer) o.customerResolved = true;
  if (r.order_id || r.name || r.order_name) {
    o.orderResolved = true;
    if (typeof r.name === "string" && r.name.startsWith("#")) o.orderName = r.name;
  }

  switch (name) {
    case "cancel_order":
      o.actionAttempted = true;
      if (r.cancelled_at || r.already_cancelled) { o.orderCancelled = true; o.actionSucceeded = true; }
      break;

    case "process_refund":
      o.actionAttempted = true;
      if (r.refund_id || r.already_refunded) {
        o.refundCreated = true;
        o.actionSucceeded = true;
        o.refundAmount = r.refunded_amount != null ? String(r.refunded_amount) : (r.amount != null ? String(r.amount) : null);
        o.refundCurrency = r.currency != null ? String(r.currency) : null;
      }
      if (r.remaining_refundable != null) o.remainingRefundableAmount = String(r.remaining_refundable);
      break;

    case "update_my_profile":
    case "update_customer":
      o.actionAttempted = true;
      // `verified` is the independent read-back, not the write's own echo.
      if (r.verified === true || (name === "update_customer" && r.id)) {
        o.customerUpdated = true;
        o.actionSucceeded = true;
      }
      break;

    case "update_order_shipping_address":
      o.actionAttempted = true;
      if (r.address_updated === true && r.verified === true) {
        o.shippingAddressUpdated = true;
        o.orderEdited = true;
        o.actionSucceeded = true;
      }
      break;

    case "exchange_order_item":
      o.actionAttempted = true;
      if (r.exchange_completed === true && r.verified === true) {
        o.exchangeCompleted = true;
        o.orderEdited = true;
        o.actionSucceeded = true;
        o.oldVariant = r.quote?.current_variant ?? r.quote?.current_title ?? null;
        o.newVariant = r.quote?.requested_variant ?? r.quote?.requested_title ?? null;
      }
      if (r.quote?.price_difference != null) o.priceDifference = String(r.quote.price_difference);
      break;

    case "create_return":
      o.actionAttempted = true;
      // A return id from the mutation is the mutation's word for it. Both the
      // created flag and the id are required, and the id is what a customer is
      // given - a return nobody can quote a reference for is not one.
      if (r.return_created === true && r.return_id) {
        o.returnCreated = true;
        o.actionSucceeded = true;
        o.returnId = String(r.return_id);
        o.returnProvider = r.return_provider ? String(r.return_provider) : "shopify";
      }
      break;

    case "add_order_note":
    case "update_order_fulfillment":
      o.actionAttempted = true;
      // Two shapes, because two tools wrote the same thing for years:
      // `add_order_note` returns note_added / tags_added (the tags one an
      // ARRAY), the legacy `update_order_fulfillment` returns noteAdded /
      // tagAdded. Reading only one spelling is how a real write goes
      // unrecorded and the reply is stripped for claiming something true.
      if (r.note_added === true || r.noteAdded === true) { o.noteAdded = true; o.actionSucceeded = true; }
      if (r.tagAdded === true || (Array.isArray(r.tags_added) && r.tags_added.length > 0)) {
        o.tagAdded = true;
        o.actionSucceeded = true;
      }
      break;

    case "create_note":
      o.actionAttempted = true;
      if (r.id || r.note != null) { o.customerUpdated = true; o.actionSucceeded = true; }
      break;

    case "send_invoice":
      o.actionAttempted = true;
      // Shopify's send_invoice sends the ORDER INVOICE EMAIL. That is a
      // confirmation/receipt, and deliberately NOT invoiceSent: a tax invoice
      // needs an invoicing provider, and conflating them is how an order
      // summary gets called an invoice.
      if (r.id || r.ok === true || r.to) {
        o.confirmationSent = true;
        o.documentSent = true;
        o.actionSucceeded = true;
        o.documentType = "order_confirmation";
        o.deliveryChannel = "email";
      }
      break;

    case "escalate_to_human":
    case "transfer_conversation":
      o.actionAttempted = true;
      o.handoffCreated = true;
      o.actionSucceeded = true;
      break;

    case "create_task":
      o.actionAttempted = true;
      if (r.id || r.task_id) { o.taskCreated = true; o.actionSucceeded = true; }
      break;

    case "schedule_followup":
    case "schedule_followup_template":
      o.actionAttempted = true;
      if (r.id || r.scheduled_at || r.ok === true) { o.followUpScheduled = true; o.actionSucceeded = true; }
      break;

    case "get_tracking_number":
    case "get_tracking_url":
    case "track_shipment":
    case "get_shipment_status":
      if (r.tracking_state === "available") o.trackingAvailable = true;
      break;

    case "inventory_status":
    case "variant_information":
      o.inventoryKnown = true;
      break;

    default:
      // A read is not an action. Only tools that declare an outcome above may
      // set actionSucceeded - the whole point is that reading an order must not
      // become evidence for having changed one.
      break;
  }

  if (Array.isArray(r.safeAlternatives)) o.supportedAlternatives = r.safeAlternatives.map(String);
  return o;
}

/** The turn's outcome, from every tool it ran. */
export function buildOutcome(records: ToolCallRecord[] | undefined): CustomerOutcome {
  let o = emptyOutcome();
  for (const rec of records ?? []) o = applyToolResult(o, rec);
  return o;
}

// ─── Claims, and the facts that would make them true ────────

export type OutcomeClaim =
  | "delegated"
  | "followup"
  | "document_sent"
  | "address_changed"
  | "exchanged"
  | "return_opened"
  | "refunded"
  | "cancelled"
  | "profile_updated"
  | "note_added"
  | "performed";

/**
 * Detection is per claim TYPE, and each pattern is written against the specific
 * sentence a customer acts on. They are deliberately loose in the gap between
 * verb and object: a noun allowlist lost four rounds against this exact model.
 */
const CLAIM_PATTERNS: Array<{ claim: OutcomeClaim; re: RegExp }> = [
  {
    claim: "delegated",
    re: /((אעביר|מעביר(ה)?|העברתי|נעביר|אפנה|פניתי|פונה|מחבר(ת)?|מקשר(ת)?|דיווחתי|יידעתי)[^\n]{0,40}?(אל\s*|ל)?(צוות|נציג|מחלק|תמיכה|שירות|חברת\s*המשלוחים|שליח)|נשלח[^\n]{0,20}?לצוות|(הצוות|הנציג|המחלקה)\s*(קיבל|יטפל|מטפל|יחזור|יבדוק|ייצור\s*קשר)|(הטיפול|הבקשה|הפנייה)\s*(עבר|עברה|הועבר|הועברה)|פתחתי\s*(קריאה|פנייה|תקלה)|i(['’]ve| have)?\s*(contacted|notified|informed|escalated|forwarded|passed)|(the\s*)?(team|support|department)\s*(will|has)\s*(handle|contact|reach|get|received))/i,
  },
  {
    claim: "followup",
    re: /(אחזור\s*אליך|נחזור\s*אליך|מחזיר(ה)?\s*(לך)?\s*תוך|חוזרת\s*אליך|(אעדכן|נעדכן|אשמח\s*לעדכן)[^\n]{0,30}?(כש|ברגע|כאשר|בהמשך|מאוחר)?|i(['’]ll| will)?\s*(get|come)\s*back\s*to\s*you|i(['’]ll| will)?\s*(let you know|update you))/i,
  },
  {
    claim: "document_sent",
    re: /(שלחתי[^\n]{0,25}?(חשבונית|קבלה|אישור|מסמך)|נשלח(ה|ו)?[^\n]{0,20}?(חשבונית|קבלה|אישור|מסמך)|(החשבונית|הקבלה|האישור)\s*(נשלח|נשלחה|בדרך|אצלך)|i\s*(have\s*)?sent\s*(you\s*)?(the\s*)?(invoice|receipt|confirmation|document))/i,
  },
  {
    claim: "address_changed",
    re: /((שיניתי|שינינו|עדכנתי|עדכנו|החלפתי)[^\n]{0,25}?(כתובת|יעד)|(הכתובת|כתובת\s*המשלוח)[^\n]{0,20}?(שונתה|עודכנה|הוחלפה)|(changed|updated)\s*(the\s*)?(shipping|delivery)?\s*address|address\s*(has\s*been\s*)?(changed|updated))/i,
  },
  {
    claim: "exchanged",
    re: /((החלפתי|החלפנו|הוחלף|הוחלפה)[^\n]{0,25}?(מידה|צבע|דגם|פריט|מוצר)|(המידה|הצבע|הפריט|המוצר)[^\n]{0,20}?(הוחלף|הוחלפה)|(swapped|exchanged)\s*(it|the|your))/i,
  },
  {
    claim: "return_opened",
    re: /((פתחתי|פתחנו|נפתחה|נפתח)[^\n]{0,25}?(החזרה|החזר\s*מוצר|בקשת\s*החזרה|rma)|(ההחזרה|בקשת\s*ההחזרה)\s*(נפתחה|נרשמה|קיימת)|(opened|created)\s*(a\s*)?(return|rma))/i,
  },
  {
    claim: "refunded",
    // The definite article is the trap here. "ביצעתי את ההחזר הכספי" carries a
    // ה on BOTH words, so a pattern written as `החזר\s*כספי` matches the noun
    // and then fails on the adjective - which is how a money claim slips
    // through while reading, to a human, exactly like the one that does not.
    re: /((ביצעתי|בוצע|בוצעה|העברתי|הועבר)[^\n]{0,25}?((ה)?החזר\s*(ה)?כספי|(ה)?זיכוי\s*(ה)?כספי)|(ההחזר\s*הכספי|הזיכוי)\s*(בוצע|בוצעה|הועבר|אושר)|(issued|processed)\s*(the\s*|a\s*)?refund)/i,
  },
  {
    claim: "cancelled",
    re: /((ביטלתי|ביטלנו|בוטלה|בוטל)[^\n]{0,20}?(ההזמנה|הזמנה)|(ההזמנה)\s*(בוטלה|מבוטלת)|(cancelled|canceled)\s*(the\s*|your\s*)?order)/i,
  },
  {
    claim: "profile_updated",
    re: /((עדכנתי|עדכנו|שיניתי|שינינו)[^\n]{0,25}?(מייל|אימייל|טלפון|נייד|פרטים|פרופיל)|(המייל|האימייל|הטלפון|הפרטים)[^\n]{0,20}?(עודכן|עודכנו|שונה|שונו)|(updated|changed)\s*(your\s*)?(email|phone|details|profile))/i,
  },
  {
    claim: "note_added",
    re: /((רשמתי|רשמנו|הוספתי|הוספנו|תיעדתי|תיעדנו)[^\n]{0,25}?(הערה|בהזמנה|על\s*ההזמנה)|(ההערה)\s*(נוספה|נרשמה)|added\s*(a\s*)?note)/i,
  },
  {
    claim: "performed",
    // The generic completed-write, kept last. Passive and active: told that
    // "ביצעתי" was being stripped, the model switched to "בקשתך עודכנה" - the
    // same false claim with no first person, which a customer cannot tell apart
    // and should not have to.
    re: /((ביצעתי|ביצענו|עשיתי|עשינו|סידרתי|סידרנו|טיפלתי|טיפלנו)|(בקשתך|הבקשה)\s*(עודכנה|בוצעה|טופלה)|זה\s*(בוצע|טופל|סודר))/i,
  },
];

const REQUIREMENTS: Record<OutcomeClaim, (o: CustomerOutcome) => boolean> = {
  delegated: (o) => o.handoffCreated || o.taskCreated || o.notificationSent,
  followup: (o) => o.followUpScheduled || o.approvalContinuationGuaranteed,
  document_sent: (o) => o.documentSent || o.invoiceSent || o.confirmationSent,
  address_changed: (o) => o.shippingAddressUpdated,
  exchanged: (o) => o.exchangeCompleted,
  return_opened: (o) => o.returnCreated && !!o.returnId,
  refunded: (o) => o.refundCreated,
  cancelled: (o) => o.orderCancelled,
  profile_updated: (o) => o.customerUpdated,
  note_added: (o) => o.noteAdded || o.tagAdded,
  performed: (o) => o.actionSucceeded,
};

/** Why each claim was rejected, in words an audit row can carry. */
export const CLAIM_REQUIREMENT_TEXT: Record<OutcomeClaim, string> = {
  delegated: "a handoff, task or notification that actually succeeded",
  followup: "a scheduled follow-up, or a pending approval whose continuation is guaranteed",
  document_sent: "a document send that returned success",
  address_changed: "an order address change confirmed by reading the order back",
  exchanged: "an exchange confirmed by reading the order back",
  return_opened: "a return that came back with a provider return id",
  refunded: "a refund that was actually created",
  cancelled: "an order that is actually cancelled",
  profile_updated: "a profile change confirmed by reading the customer back",
  note_added: "a note or tag confirmed on the order",
  performed: "any write that actually succeeded",
};

export interface OutcomeVerdict {
  ok: boolean;
  unsupported: Array<{ claim: OutcomeClaim; match: string; requires: string }>;
}

/**
 * Which of this reply's claims the facts do not support.
 *
 * Note what is NOT here: any notion of "some tool ran, so the reply is fine".
 * A claim is checked against the facts that claim is about, which is the whole
 * difference from the previous net.
 */
export function validateOutcomeClaims(
  replyText: string | null | undefined,
  outcome: CustomerOutcome,
): OutcomeVerdict {
  if (!replyText) return { ok: true, unsupported: [] };
  const unsupported: OutcomeVerdict["unsupported"] = [];
  for (const { claim, re } of CLAIM_PATTERNS) {
    const m = re.exec(replyText);
    if (!m) continue;
    if (REQUIREMENTS[claim](outcome)) continue;
    unsupported.push({ claim, match: m[0], requires: CLAIM_REQUIREMENT_TEXT[claim] });
  }
  return { ok: unsupported.length === 0, unsupported };
}

const SENTENCE_SPLIT = /(?<=[.!?׃])\s+|\n+/;

/**
 * Remove the sentences that make unsupported claims.
 *
 * Per sentence, so the true half of a reply survives: the model usually states
 * real facts first and over-promises at the end. Returns null when nothing had
 * to go, so callers can tell "unchanged" from "rewritten", and also when
 * EVERYTHING had to go - a reply cut to nothing is not an improvement on a
 * reply that was wrong, and the caller needs to know to say something else
 * instead.
 */
export function stripUnsupportedClaims(
  replyText: string | null | undefined,
  verdict: OutcomeVerdict,
): string | null {
  if (!replyText || verdict.ok) return null;
  const claims = new Set(verdict.unsupported.map((u) => u.claim));
  const patterns = CLAIM_PATTERNS.filter((p) => claims.has(p.claim)).map((p) => p.re);
  const sentences = String(replyText).split(SENTENCE_SPLIT);
  const kept = sentences.filter((s) => !patterns.some((re) => re.test(s)));
  if (kept.length === sentences.length) return null;
  const rebuilt = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  if (rebuilt.length < 3) return null;
  return rebuilt;
}

/**
 * The facts, as a block the model writes FROM rather than around.
 *
 * Validation after the fact can only delete; this is what lets a reply be
 * right the first time. It is emitted only when something actually happened,
 * because an empty fact block is noise that dilutes the rest of the turn.
 */
export function buildOutcomeFactBlock(outcome: CustomerOutcome): string | null {
  const facts: string[] = [];
  const add = (label: string, ok: boolean, extra?: string) => {
    if (ok) facts.push(`- ${label}${extra ? `: ${extra}` : ""}`);
  };

  add("The order was cancelled", outcome.orderCancelled, outcome.orderName ?? undefined);
  add(
    "A refund was created",
    outcome.refundCreated,
    [outcome.refundAmount, outcome.refundCurrency].filter(Boolean).join(" ") || undefined,
  );
  add("The customer's own profile was updated and read back", outcome.customerUpdated);
  add("The order's shipping address was changed and read back", outcome.shippingAddressUpdated);
  add(
    "An exchange was completed and read back",
    outcome.exchangeCompleted,
    outcome.oldVariant && outcome.newVariant ? `${outcome.oldVariant} → ${outcome.newVariant}` : undefined,
  );
  add("A return was opened", outcome.returnCreated, outcome.returnId ?? undefined);
  add("A note was added to the order", outcome.noteAdded);
  add("A tag was added to the order", outcome.tagAdded);
  add("A document was sent", outcome.documentSent, [outcome.documentType, outcome.deliveryChannel].filter(Boolean).join(" by ") || undefined);
  add("A handoff to a person was created", outcome.handoffCreated);
  add("A task was created", outcome.taskCreated);
  add("A follow-up was scheduled", outcome.followUpScheduled);
  add("An approval is pending and the system will send exactly one update when it is decided", outcome.approvalContinuationGuaranteed);

  if (!facts.length) {
    if (!outcome.actionAttempted) return null;
    return (
      "# WHAT ACTUALLY HAPPENED THIS TURN\n" +
      "Nothing was changed. You attempted an action and it did not complete.\n" +
      "You may NOT say anything was done, opened, sent, updated, changed or passed to anyone.\n" +
      "Say what you could not do, and offer something real."
    );
  }

  return (
    "# WHAT ACTUALLY HAPPENED THIS TURN\n" +
    "These are the ONLY completed actions you may tell the customer about:\n" +
    facts.join("\n") +
    "\nAnything not on this list did NOT happen. Do not imply it did, in any wording, active or passive."
  );
}
