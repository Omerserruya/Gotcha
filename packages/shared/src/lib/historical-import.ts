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
 * The ONE number the progress bar is allowed to show, or null when no honest
 * number exists.
 *
 * During transfer this is the source's own percentage. Afterwards it is null -
 * deliberately. We cannot measure how far through "understanding your
 * customers" we are, and inventing 87% to keep a bar moving is the kind of
 * detail that makes everything else on the page less believable. The analyzing
 * stage shows counted work instead; see `historicalAnalysisCounts`.
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
