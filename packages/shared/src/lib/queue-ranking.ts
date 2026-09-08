/**
 * How the "needs you now" queue is ordered.
 *
 * SERVER-SIDE, and pure. Two surfaces ranking the same queue independently
 * will disagree the moment either changes, and an operator who sees a
 * different first row on Home than in the inbox stops trusting both. This is
 * the single definition; endpoints call it, they do not re-implement it.
 *
 * Deliberately arithmetic rather than a model. An operator can be told exactly
 * why a row is at the top - "waiting 40 minutes, and it is a complaint" - and
 * two refreshes a second apart produce the same order. An LLM ranking would be
 * better at the margins and worse at both of those, and it would spend AI
 * Units on every dashboard load.
 */
import type { ConversationIntent } from "./conversation-intent";

/**
 * What each intent multiplies waiting time by.
 *
 * WAITING_EXTERNAL is below 1 on purpose: the customer is blocked on a carrier
 * or a supplier, not on us, and putting that above someone we are actually
 * keeping waiting would be measuring the wrong thing.
 */
const INTENT_WEIGHT: Record<ConversationIntent, number> = {
  FRUSTRATED: 3.0,
  COMPLAINT: 3.0,
  HIGH_INTENT: 2.0,
  REFUND: 1.6,
  SHIPPING_ISSUE: 1.6,
  RETURN: 1.4,
  ORDER_CHANGE: 1.4,
  PRODUCT_QUESTION: 1.0,
  OTHER: 1.0,
  WAITING_EXTERNAL: 0.5,
};

/**
 * Minutes-equivalent added per unanswered follow-up beyond the first.
 *
 * Someone writing a third time has told us twice that the first message was
 * not enough, and pure wait time cannot see that: three messages in five
 * minutes scores below one message from an hour ago, which is backwards.
 */
const REPEAT_WEIGHT_MINUTES = 20;

/** Score thresholds, in the same minutes-equivalent unit as the score. */
const URGENCY_HIGH = 240;
const URGENCY_MEDIUM = 60;
const URGENCY_LOW = 15;

export type QueueUrgency = "high" | "medium" | "low" | "none";

export interface QueueRankInput {
  /** When the customer last wrote. Not lastMessageAt - an outbound reply is
   *  not the customer waiting. */
  waitingSince: Date;
  intent: ConversationIntent;
  /** Inbound messages since our last outbound. 1 = they wrote once. */
  unansweredInbound: number;
  /**
   * Angry, whatever the subject.
   *
   * Carried separately because `intent` reports the SUBJECT: someone furious
   * about a refund shows the agent REFUND, which is what they act on, and the
   * classifier deliberately does not overwrite that with the tone. Without this
   * flag that row would also lose its heat and score 1.6x instead of 3x, so the
   * most upset customer in the queue would sit below a routine question that
   * had been waiting slightly longer.
   */
  frustrated?: boolean;
}

export interface QueueScore {
  score: number;
  urgency: QueueUrgency;
  waitMinutes: number;
}

export function scoreQueueItem(input: QueueRankInput, now: Date = new Date()): QueueScore {
  // Clamped at zero: a clock skew between services must not produce a negative
  // score that sorts a live conversation below everything.
  const waitMinutes = Math.max(0, (now.getTime() - input.waitingSince.getTime()) / 60_000);
  // The heavier of the two readings. A frustrated PRODUCT_QUESTION is at least
  // as urgent as a complaint; a frustrated COMPLAINT is not more than one.
  const subjectWeight = INTENT_WEIGHT[input.intent] ?? 1.0;
  const weight = input.frustrated
    ? Math.max(subjectWeight, INTENT_WEIGHT.FRUSTRATED)
    : subjectWeight;
  const repeats = Math.max(0, (input.unansweredInbound || 1) - 1);
  const score = Math.round(waitMinutes * weight + repeats * REPEAT_WEIGHT_MINUTES);

  const urgency: QueueUrgency =
    score >= URGENCY_HIGH ? "high" : score >= URGENCY_MEDIUM ? "medium" : score >= URGENCY_LOW ? "low" : "none";

  return { score, urgency, waitMinutes: Math.round(waitMinutes) };
}

/**
 * Order a scored set, highest first, and stamp each row's 1-based rank.
 *
 * The tiebreak is the older `waitingSince`, then the id. Without a total order
 * two equal scores could swap between requests, which turns cursor pagination
 * into a page that drops or repeats rows.
 */
export function rankQueueItems<T extends { id: string; waitingSince: Date; score: number }>(
  items: T[],
): Array<T & { rank: number }> {
  return [...items]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.waitingSince.getTime() - b.waitingSince.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((item, i) => ({ ...item, rank: i + 1 }));
}

export const __QUEUE_RANKING_INTERNALS__ = {
  INTENT_WEIGHT,
  REPEAT_WEIGHT_MINUTES,
  URGENCY_HIGH,
  URGENCY_MEDIUM,
  URGENCY_LOW,
};
