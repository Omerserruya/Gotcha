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

/**
 * The one number the progress bar may show, or null when no honest number
 * exists. Null during analysis is deliberate: see the shared original.
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
