/**
 * Client mirror of `packages/shared/src/lib/historical-import.ts`.
 *
 * The frontend is not an npm workspace and cannot import `@chatcenter/shared`
 * at runtime, so the stage mapping is duplicated here and held to the original
 * by a parity test. Same convention as `tool-availability-client.ts` and the
 * embedded-signup version.
 *
 * Keep the two in step. If they drift, the channel card and the API will
 * describe the same import differently, which is the specific bug this file
 * exists to make loud instead of silent.
 */

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

export type HistoricalImportStage =
  | "transferring"
  | "analyzing"
  | "ready"
  | "unavailable"
  | "failed";

const ANALYZING: ReadonlySet<HistoricalImportStatus> = new Set<HistoricalImportStatus>([
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
  return "transferring";
}

export function isHistoricalImportTerminal(status: HistoricalImportStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "NOT_AVAILABLE";
}

export function hasHistoricalResults(status: HistoricalImportStatus): boolean {
  return status === "REVIEW_READY" || status === "COMPLETED";
}

/** How much of the history the source has sent. Mirror of the shared original. */
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
 * How far analysis has got, 0-100. Mirror of the shared original - the bands
 * and the measured fractions must match it exactly, and the parity test says so.
 */
const ANALYSIS_BANDS: Array<{ status: HistoricalImportStatus; from: number; to: number }> = [
  { status: "SOURCE_COMPLETE", from: 0, to: 3 },
  { status: "INGESTING", from: 3, to: 8 },
  { status: "IDENTITY_RESOLUTION", from: 8, to: 15 },
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

export const HISTORICAL_SOURCE_WINDOW_DAYS = 180;

/** The shape `GET /api/historical-imports` returns per row. */
export interface HistoricalImportView {
  id: string;
  source: string;
  channelAccountId: string | null;
  status: HistoricalImportStatus;
  stage: HistoricalImportStage;
  percent: number | null;
  /** Analysis progress, 0-100. Null unless analysis is running. */
  analysisPercent: number | null;
  analysisCounts: { analyzed: number; total: number } | null;
  hasResults: boolean;
  importedMessages: number;
  importedCustomers: number;
  knowledgeCandidateCount: number;
  knowledgeConflictCount: number;
  failureReason: string | null;
  failedStage: string | null;
  startedAt: string;
  sourceCompletedAt: string | null;
  completedAt: string | null;
  sourceDeadlineAt: string | null;
  windowDays: number;
}
