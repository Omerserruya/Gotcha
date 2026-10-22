/**
 * The conversation-intent domain, and the mapping from what is stored onto it.
 *
 * WHY A NORMALIZER RATHER THAN A COLUMN
 * -------------------------------------
 * `ConversationIntelligence.detectedIntent` is a plain String written by two
 * different producers: the AI service, which returns free text, and the local
 * heuristic fallback in incoming-worker, which emits its own five labels
 * (`sales_inquiry`, `billing`, `technical_support`, `order_inquiry`,
 * `general`). Neither vocabulary is the one a queue row or a message chip needs,
 * and the live database holds values like "unknown" and "general" that mean
 * nothing to an operator.
 *
 * So this is a READ-side mapping. It does not rewrite history and it does not
 * change what the writers store - `getTopQuestions` and `getAIInsights` group by
 * the raw column, and silently changing its vocabulary would move their numbers
 * without anyone asking. What it does guarantee is that every consumer of an
 * intent sees the same ten codes, including for rows written before this
 * existed.
 *
 * Codes, never display strings: the frontend renders these in Hebrew, and a
 * sentence composed here cannot be translated there.
 */

export const CONVERSATION_INTENTS = [
  /** Angry or exasperated. A STATE rather than a subject, and it outranks one. */
  "FRUSTRATED",
  /** Ready to buy: price, plan, demo, quote. */
  "HIGH_INTENT",
  /** Blocked on a third party - a carrier, a supplier. Nobody here is late. */
  "WAITING_EXTERNAL",
  "ORDER_CHANGE",
  "RETURN",
  "REFUND",
  "SHIPPING_ISSUE",
  "PRODUCT_QUESTION",
  "COMPLAINT",
  /** Genuinely unclassified. Never a dumping ground for "we did not look". */
  "OTHER",
] as const;

export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];

export function isConversationIntent(v: unknown): v is ConversationIntent {
  return typeof v === "string" && (CONVERSATION_INTENTS as readonly string[]).includes(v);
}

/**
 * Signals that can override a weak subject classification.
 *
 * A message can be ABOUT shipping and still be the third furious one this
 * week, and which of those an operator needs to see first is not a close call.
 */
export interface IntentSignals {
  /** ConversationIntelligence.sentiment: "positive" | "negative" | "neutral". */
  sentiment?: string | null;
  /** ConversationIntelligence.sentimentScore, -1.0 to 1.0. */
  sentimentScore?: number | null;
  /** ConversationIntelligence.customerEffort, 1-5. */
  customerEffort?: number | null;
}

/**
 * SUBJECT patterns - what the conversation is ABOUT.
 *
 * Checked before tone, because a subject is actionable and a tone is not:
 * REFUND tells an agent which screen to open, FRUSTRATED only tells them how
 * the customer feels, and the row already carries `urgency` for that. Someone
 * furious about a refund is a REFUND row marked high.
 *
 * Ordered so the more specific phrase wins - RETURN's "send back" before
 * SHIPPING_ISSUE's bare "ship". Substring matching is deliberate: the AI
 * producer is not constrained to any vocabulary, so this has to cope with
 * whatever sentence fragment it stored.
 */
const SUBJECT_PATTERNS: Array<[RegExp, ConversationIntent]> = [
  [/\b(refund|money back|chargeback|reimburse)/i, "REFUND"],
  [/\b(return|exchange|rma|send.?back)/i, "RETURN"],
  [/\b(ship|deliver|track|courier|parcel|package|late|delay|lost)/i, "SHIPPING_ISSUE"],
  [/\b(cancel|amend|change.*order|order.*change|modif|address change)/i, "ORDER_CHANGE"],
  [/\b(waiting|awaiting|supplier|backorder|restock|third.?part)/i, "WAITING_EXTERNAL"],
  [/\b(price|pricing|buy|purchase|plan|upgrade|demo|trial|quote|sales)/i, "HIGH_INTENT"],
  [/\b(product|size|sizing|colour|color|material|spec|stock|availab|fit)/i, "PRODUCT_QUESTION"],
];

/**
 * TONE patterns - how the customer is, when nothing says what about.
 *
 * These are the fallback classification AND the frustration signal that the
 * ranker reads separately, so "furious about the refund" is a REFUND row that
 * still scores like a complaint. Collapsing the two into one field would force
 * a choice between telling the agent what to do and telling them it is hot.
 */
const TONE_PATTERNS: Array<[RegExp, ConversationIntent]> = [
  [/\b(complain|complaint|escalat|dissatisf|poor service)/i, "COMPLAINT"],
  [/\b(furious|angry|frustrat|upset|unacceptable|outrage)/i, "FRUSTRATED"],
];

/**
 * The five labels the heuristic fallback actually writes, mapped explicitly
 * rather than left to the patterns above.
 *
 * `billing` is the interesting one. Its regex covers invoice, bill, payment,
 * charge, subscription AND refund, so calling it REFUND would assert a refund
 * request for every invoice question. OTHER is less useful and true; the
 * alternative is a queue that tells an operator someone wants their money back
 * when they asked when they get billed.
 */
const HEURISTIC_LABELS: Record<string, ConversationIntent> = {
  sales_inquiry: "HIGH_INTENT",
  order_inquiry: "SHIPPING_ISSUE",
  technical_support: "OTHER",
  billing: "OTHER",
  general: "OTHER",
  unknown: "OTHER",
};

/** Sentiment at or below this reads as frustration rather than a mood. */
const FRUSTRATION_SCORE = -0.4;
/** customerEffort is 1-5; 4 means the customer has had to repeat themselves. */
const FRUSTRATION_EFFORT = 4;

/**
 * Map a stored intent onto the domain.
 *
 * Order of decision:
 *   1. A value already in the domain passes through - so once the writers do
 *      emit these codes, nothing here has to change.
 *   2. A known heuristic label uses its explicit mapping.
 *   3. Otherwise, pattern-match the free text.
 *   4. Failing a subject, tone: COMPLAINT or FRUSTRATED.
 *   5. Failing both, sentiment can still produce FRUSTRATED.
 *
 * A specific subject is never overridden by tone. A customer can be angry
 * about a refund, and REFUND is the more actionable of the two - it says what
 * to do, where FRUSTRATED only says how they feel. The heat is not lost:
 * `isFrustrated` reports it separately and the queue ranker weights on it.
 */
export function normalizeConversationIntent(
  raw: string | null | undefined,
  signals: IntentSignals = {},
): ConversationIntent {
  let intent: ConversationIntent | null = null;

  const value = typeof raw === "string" ? raw.trim() : "";
  if (value) {
    const upper = value.toUpperCase();
    if (isConversationIntent(upper)) {
      intent = upper;
    } else {
      const mapped = HEURISTIC_LABELS[value.toLowerCase()];
      if (mapped) {
        intent = mapped;
      } else {
        for (const [re, code] of SUBJECT_PATTERNS) {
          if (re.test(value)) {
            intent = code;
            break;
          }
        }
        if (intent === null) {
          for (const [re, code] of TONE_PATTERNS) {
            if (re.test(value)) {
              intent = code;
              break;
            }
          }
        }
      }
    }
  }

  const frustrated =
    (typeof signals.sentimentScore === "number" && signals.sentimentScore <= FRUSTRATION_SCORE) ||
    (signals.sentiment === "negative" &&
      typeof signals.customerEffort === "number" &&
      signals.customerEffort >= FRUSTRATION_EFFORT);

  if (frustrated && (intent === null || intent === "OTHER")) return "FRUSTRATED";
  return intent ?? "OTHER";
}

/**
 * Is this customer angry, regardless of what they are angry ABOUT?
 *
 * Read by the queue ranker so a frustrated REFUND ranks like a complaint while
 * still showing the agent the subject. Kept beside the classifier so the two
 * read the same signals - a second threshold elsewhere is a second definition
 * of "upset", and they would drift.
 */
export function isFrustrated(
  raw: string | null | undefined,
  signals: IntentSignals = {},
): boolean {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value && TONE_PATTERNS.some(([re]) => re.test(value))) return true;
  if (typeof signals.sentimentScore === "number" && signals.sentimentScore <= FRUSTRATION_SCORE) {
    return true;
  }
  return (
    signals.sentiment === "negative" &&
    typeof signals.customerEffort === "number" &&
    signals.customerEffort >= FRUSTRATION_EFFORT
  );
}
