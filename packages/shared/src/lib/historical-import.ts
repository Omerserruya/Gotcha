/**
 * The shape of a historical import as the product talks about it.
 *
 * The database status has thirteen members because the pipeline has thirteen
 * places it can be. A person watching a progress bar has four questions:
 * is it coming, is it thinking, can I look at it, did it break. This module is
 * the single mapping between those two, so the channel card, the results page
 * and the completion email can never describe the same import differently.
 *
 * The frontend cannot import this file - it is not an npm workspace - so a
 * mirror lives at `frontend/src/lib/historical-import-client.ts` and a parity
 * test holds the two together. Same convention as tool-availability and the
 * embedded-signup version.
 */

/** Mirrors the Prisma `HistoricalImportStatus` enum. */
export type HistoricalImportStatus =
  | "NOT_AVAILABLE"
  | "PENDING"
  | "SOURCE_SYNCING"
  | "SOURCE_COMPLETE"
  | "INGESTING"
  | "IDENTITY_RESOLUTION"
  | "CUSTOMER_LEARNING"
  | "KNOWLEDGE_EXTRACTION"
  | "KNOWLEDGE_CLUSTERING"
  | "ANALYTICS"
  | "REVIEW_READY"
  | "COMPLETED"
  | "FAILED";

/**
 * What the customer is actually looking at.
 *
 *  - `transferring`  the source is still sending. We have a real percentage.
 *  - `analyzing`     everything arrived; we are learning from it. NO honest
 *                    percentage exists here, so the UI counts work instead.
 *  - `ready`         there are results to look at.
 *  - `unavailable`   the source will not give us history. Not a failure.
 *  - `failed`        something broke. Partial results may still exist.
 */
export type HistoricalImportStage =
  | "transferring"
  | "analyzing"
  | "ready"
  | "unavailable"
  | "failed";

const ANALYZING: ReadonlySet<HistoricalImportStatus> = new Set([
  "SOURCE_COMPLETE",
  "INGESTING",
  "IDENTITY_RESOLUTION",
  "CUSTOMER_LEARNING",
  "KNOWLEDGE_EXTRACTION",
  "KNOWLEDGE_CLUSTERING",
  "ANALYTICS",
]);

export function historicalImportStage(status: HistoricalImportStatus): HistoricalImportStage {
  if (status === "NOT_AVAILABLE") return "unavailable";
  if (status === "FAILED") return "failed";
  if (status === "REVIEW_READY" || status === "COMPLETED") return "ready";
  if (ANALYZING.has(status)) return "analyzing";
  // PENDING and SOURCE_SYNCING. PENDING is "transferring" on purpose: from the
  // customer's side they have just finished signup and history is on its way,
  // and a separate "waiting" state would be a distinction without a difference.
  return "transferring";
}

/** Nothing more will happen to this import without a human doing something. */
export function isHistoricalImportTerminal(status: HistoricalImportStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "NOT_AVAILABLE";
}

/**
 * True once the import has produced something worth opening.
 *
 * Used for the "View what GOTCHA learned" entry point, which must not appear
 * before there is anything behind it.
 */
export function hasHistoricalResults(status: HistoricalImportStatus): boolean {
  return status === "REVIEW_READY" || status === "COMPLETED";
}

/**
 * The transfer percentage: how much of the history the source has sent.
 *
 * This is Meta's own number and nothing else. It is NOT a percentage of the
 * whole import - analysis has its own, see `historicalAnalysisPercent` - because
 * the two phases are different work with different durations, and one bar
 * covering both would sit at 50% for hours and then finish in a minute.
 */
export function historicalImportPercent(input: {
  status: HistoricalImportStatus;
  sourceProgress: number;
}): number | null {
  const stage = historicalImportStage(input.status);
  if (stage === "transferring") {
    return Math.max(0, Math.min(100, Math.round(input.sourceProgress || 0)));
  }
  if (stage === "ready") return 100;
  return null;
}

/**
 * Where analysis has got to, 0-100, or null when it is not running.
 *
 * ── Why this exists now, when it deliberately did not before ──
 *
 * The original rule was that analysis has no honest percentage and a bar that
 * invents one poisons every real number near it. That reasoning still holds
 * against an INVENTED number. It does not hold against a counted one, and by
 * the time the pipeline was finished two of its stages were already counting:
 * customer learning walks a known set of customers, knowledge extraction walks
 * a known set of conversations. Those two stages are the long ones - together
 * they are effectively the whole wait - and within each, the fraction below is
 * measured from rows that have actually been processed.
 *
 * ── What is measured and what is a weight ──
 *
 * The fraction INSIDE a stage is measured. The share each stage gets of the
 * total is a fixed weight, listed here in the open, chosen from observed
 * durations on real imports rather than divided evenly - identity resolution is
 * minutes and extraction is hours, so giving them equal thirds would make the
 * bar lie in a different direction. A weight is not a measurement, which is why
 * the bands are wide and the UI names the stage next to the number: the
 * percentage says roughly how far, the label says exactly what is happening.
 *
 * Progress never goes backwards: a stage's floor is its band start, so a retry
 * that re-runs a batch cannot drag the bar down.
 */
const ANALYSIS_BANDS: Array<{ status: HistoricalImportStatus; from: number; to: number }> = [
  { status: "SOURCE_COMPLETE", from: 0, to: 3 },
  { status: "INGESTING", from: 3, to: 8 },
  { status: "IDENTITY_RESOLUTION", from: 8, to: 15 },
  // The two long ones, and the only two with a measured fraction.
  { status: "CUSTOMER_LEARNING", from: 15, to: 50 },
  { status: "KNOWLEDGE_EXTRACTION", from: 50, to: 85 },
  { status: "KNOWLEDGE_CLUSTERING", from: 85, to: 95 },
  { status: "ANALYTICS", from: 95, to: 99 },
];

export function historicalAnalysisPercent(input: {
  status: HistoricalImportStatus;
  customersAnalyzed: number;
  customersTotal: number;
  conversationsExtracted: number;
  conversationsEligible: number;
}): number | null {
  if (historicalImportStage(input.status) !== "analyzing") return null;
  const band = ANALYSIS_BANDS.find((b) => b.status === input.status);
  if (!band) return null;

  let fraction = 0;
  if (input.status === "CUSTOMER_LEARNING" && input.customersTotal > 0) {
    fraction = input.customersAnalyzed / input.customersTotal;
  } else if (input.status === "KNOWLEDGE_EXTRACTION" && input.conversationsEligible > 0) {
    fraction = input.conversationsExtracted / input.conversationsEligible;
  }
  fraction = Math.max(0, Math.min(1, fraction));

  return Math.round(band.from + (band.to - band.from) * fraction);
}

/**
 * Real, countable progress for the analyzing stage: "842 / 1,247 customers".
 *
 * Returns null until there is something to count, so the UI shows plain stage
 * text rather than "0 / 0".
 */
export function historicalAnalysisCounts(input: {
  status: HistoricalImportStatus;
  customersAnalyzed: number;
  customersTotal: number;
}): { analyzed: number; total: number } | null {
  if (historicalImportStage(input.status) !== "analyzing") return null;
  if (!input.customersTotal || input.customersTotal <= 0) return null;
  return {
    analyzed: Math.max(0, Math.min(input.customersAnalyzed || 0, input.customersTotal)),
    total: input.customersTotal,
  };
}

/**
 * The order stages run in. Used to decide whether an incoming update is
 * progress or a late duplicate: a webhook retry must never drag an import that
 * has reached CUSTOMER_LEARNING back to SOURCE_SYNCING.
 */
const STATUS_ORDER: HistoricalImportStatus[] = [
  "PENDING",
  "SOURCE_SYNCING",
  "SOURCE_COMPLETE",
  "INGESTING",
  "IDENTITY_RESOLUTION",
  "CUSTOMER_LEARNING",
  "KNOWLEDGE_EXTRACTION",
  "KNOWLEDGE_CLUSTERING",
  "ANALYTICS",
  "REVIEW_READY",
  "COMPLETED",
];

/**
 * Whether `next` is genuinely forward of `current`.
 *
 * FAILED and NOT_AVAILABLE are outside the ordering: either can be entered from
 * anywhere, and neither can be left by anything except an explicit retry.
 */
export function isForwardTransition(
  current: HistoricalImportStatus,
  next: HistoricalImportStatus,
): boolean {
  if (next === current) return false;
  if (next === "FAILED" || next === "NOT_AVAILABLE") return true;
  if (current === "FAILED" || current === "NOT_AVAILABLE") return false;
  const from = STATUS_ORDER.indexOf(current);
  const to = STATUS_ORDER.indexOf(next);
  if (from < 0 || to < 0) return false;
  return to > from;
}

/**
 * Meta gives partners 24 hours from onboarding to pull the history, after which
 * the business has to offboard and complete Embedded Signup again. Exported so
 * the deadline is set from one place and the watchdog compares against the same
 * number the import was created with.
 */
export const HISTORICAL_SOURCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the source can reach, in days. Shown to the customer so
 * "we imported your history" is never read as "all of it".
 */
export const HISTORICAL_SOURCE_WINDOW_DAYS = 180;
