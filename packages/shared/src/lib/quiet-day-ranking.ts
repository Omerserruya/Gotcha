/**
 * Ranking the quiet-day list across four unrelated sources.
 *
 * The card mixes units that have nothing to do with each other: 33 people asked
 * a question we could not answer, N customers affected by a conflicting fact,
 * 640 customers who have gone quiet, 22 requests for a product not stocked.
 * Nothing put those in one order, so whoever rendered them had to invent
 * weights - and two surfaces inventing their own weights is the same failure
 * the queue ranking exists to prevent.
 *
 * ONE COMPARABLE NUMBER: `wouldRemoveConversations`, an estimate of the future
 * conversations each item stops from happening. It is arithmetic over counts
 * that were actually recorded, never a model, so an owner can be told why an
 * item is at the top and two refreshes give the same order.
 *
 * THE SIGN PROBLEM, STATED RATHER THAN HIDDEN
 * Three of the four sources REMOVE work: answer the question, resolve the
 * conflict, stock the product, and those conversations stop arriving. Dormant
 * customers are the opposite - acting on them CREATES conversations, and that
 * is the point of them. Ranking an opportunity by how much work it removes
 * would put it last for being valuable.
 *
 * So every item carries `effect`, and the ranking only orders within
 * `removes_work`. An opportunity is not scored against a chore; the client
 * shows it as its own thing. Collapsing the two into one number would have
 * produced a confident ordering of incomparable things, which is worse than
 * admitting there are two lists.
 */

export type QuietDayEffect = "removes_work" | "creates_opportunity";

export type QuietDaySource =
  | "unanswered_question"
  | "knowledge_conflict"
  | "product_demand"
  | "dormant_customers";

export interface QuietDayItem {
  id: string;
  source: QuietDaySource;
  effect: QuietDayEffect;
  /**
   * Future conversations this removes, over the horizon below. Null for an
   * opportunity, where the number would be a different thing wearing the same
   * name.
   */
  wouldRemoveConversations: number | null;
  /** The counts the estimate was built from, so it can be argued with. */
  basis: Record<string, number>;
  /** Codes and figures only - the client writes the sentence. */
  kind: string;
  values: Record<string, unknown>;
  rank: number;
}

/**
 * How far ahead the estimate looks, in weeks.
 *
 * A quarter. Short enough that "this keeps happening" is still a safe
 * assumption, long enough that a weekly recurrence is worth an hour today.
 */
export const HORIZON_WEEKS = 13;

/**
 * What share of a recurring ask actually turns into a conversation once the
 * gap is closed.
 *
 * Below 1 because closing a gap does not silence every future asker: some
 * would have asked anyway, and a written answer is not always read. Being
 * deliberately conservative here matters more than being precise - the number
 * decides what an owner spends an hour on, and overstating it spends their
 * hour on the wrong thing.
 */
const DEFLECTION_RATE = 0.7;

export interface UnansweredInput {
  id: string; question: string; reason: string;
  askCount: number; askedBy: number; weeksObserved: number;
}
export interface ConflictInput {
  id: string; fieldKey: string; affectedCustomerCount: number | null;
}
export interface DemandInput {
  id: string; term: string; askCount: number; askedBy: number; weeksRunning: number;
}
export interface DormantInput { count: number; quietForDays: number }

/** Weekly rate from a count observed over a window, floored at one week. */
function perWeek(count: number, weeks: number): number {
  return count / Math.max(1, weeks);
}

export function buildQuietDayList(input: {
  unanswered: UnansweredInput[];
  conflicts: ConflictInput[];
  demand: DemandInput[];
  dormant: DormantInput | null;
}): QuietDayItem[] {
  const work: Array<Omit<QuietDayItem, "rank">> = [];

  for (const u of input.unanswered) {
    const estimate = Math.round(perWeek(u.askCount, u.weeksObserved) * HORIZON_WEEKS * DEFLECTION_RATE);
    work.push({
      id: u.id,
      source: "unanswered_question",
      effect: "removes_work",
      wouldRemoveConversations: estimate,
      basis: { askCount: u.askCount, askedBy: u.askedBy, weeksObserved: u.weeksObserved, horizonWeeks: HORIZON_WEEKS },
      kind: `knowledge_gap.${u.reason}`,
      values: { question: u.question, askCount: u.askCount, askedBy: u.askedBy },
    });
  }

  for (const c of input.conflicts) {
    // A conflict is not a recurring ask - it is a wrong answer already in the
    // record. Its reach is the customers it touches, once, so it is NOT
    // multiplied by the horizon. Doing so would let one disputed field
    // outrank every genuine gap.
    const affected = c.affectedCustomerCount ?? 1;
    work.push({
      id: c.id,
      source: "knowledge_conflict",
      effect: "removes_work",
      wouldRemoveConversations: affected,
      basis: { affectedCustomerCount: affected },
      kind: "knowledge_conflict.pending",
      values: { field: c.fieldKey, affectedCustomerCount: affected },
    });
  }

  for (const d of input.demand) {
    const estimate = Math.round(perWeek(d.askCount, d.weeksRunning) * HORIZON_WEEKS * DEFLECTION_RATE);
    work.push({
      id: d.id,
      source: "product_demand",
      effect: "removes_work",
      wouldRemoveConversations: estimate,
      basis: { askCount: d.askCount, askedBy: d.askedBy, weeksRunning: d.weeksRunning, horizonWeeks: HORIZON_WEEKS },
      kind: "product_demand.not_stocked",
      values: { term: d.term, askCount: d.askCount, askedBy: d.askedBy, weeksRunning: d.weeksRunning },
    });
  }

  const ranked = work
    .sort(
      (a, b) =>
        (b.wouldRemoveConversations ?? 0) - (a.wouldRemoveConversations ?? 0) ||
        // A total order, so paging cannot drop or repeat a row.
        a.source.localeCompare(b.source) ||
        a.id.localeCompare(b.id),
    )
    .map((item, i) => ({ ...item, rank: i + 1 }));

  if (input.dormant && input.dormant.count > 0) {
    // Appended, deliberately unranked against the rest, and last in the array
    // so a client that ignores `effect` still shows the chores first.
    ranked.push({
      id: "dormant-customers",
      source: "dormant_customers",
      effect: "creates_opportunity",
      wouldRemoveConversations: null,
      basis: { count: input.dormant.count, quietForDays: input.dormant.quietForDays },
      kind: "dormant_customers.reachable",
      values: { count: input.dormant.count, quietForDays: input.dormant.quietForDays },
      rank: ranked.length + 1,
    });
  }

  return ranked;
}
