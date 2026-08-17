import { createWorker, prisma, type HistoricalIntelligenceJob } from "@chatcenter/shared";
import { processHistoricalIntelligence } from "../../services/historical-intelligence";
import { recordEvent } from "../../services/historical-intelligence/stage-utils";

/**
 * Runs the intelligence stages of a historical import.
 *
 * Concurrency is 2, deliberately low. Each job is a batch of LLM calls that
 * already fans out internally, so the real parallelism is higher than the
 * number suggests. This service also serves live customer turns from the same
 * process, and a background import is never allowed to be the reason somebody's
 * message waits.
 */

const CONCURRENCY = 2;

let worker: any;

export function startHistoricalIntelligenceWorker(): void {
  worker = createWorker<HistoricalIntelligenceJob>(
    "historical-intelligence",
    processHistoricalIntelligence,
    CONCURRENCY,
  );
  console.log("[historical-intelligence] worker started (stages: identity, customer-learning, knowledge-extraction, knowledge-clustering, analytics, finalize)");
}

/**
 * Fail imports whose source window has closed.
 *
 * Meta gives partners 24 hours from onboarding to pull the history and then
 * stops; a transfer that never reached 100 will never reach it. Without this
 * sweep the channel card would show a bar frozen at 60% indefinitely, which
 * tells the customer nothing and hides the one thing they can act on, which is
 * that re-importing means offboarding and completing signup again.
 *
 * Runs on a plain interval rather than a repeatable job: it is a cheap query
 * against an indexed column, and a missed tick is harmless because the next one
 * catches the same rows.
 */
const WATCHDOG_INTERVAL_MS = 15 * 60 * 1000;

let watchdog: NodeJS.Timeout | null = null;

export function startHistoricalImportWatchdog(): void {
  if (watchdog) return;
  const tick = async () => {
    try {
      const stale = await prisma.historicalImport.findMany({
        where: {
          status: { in: ["PENDING", "SOURCE_SYNCING"] },
          sourceDeadlineAt: { lt: new Date() },
        },
        select: { id: true, sourceProgress: true, chunksReceived: true },
        take: 50,
      });
      for (const row of stale) {
        await prisma.historicalImport.updateMany({
          where: { id: row.id, status: { in: ["PENDING", "SOURCE_SYNCING"] } },
          data: {
            status: "FAILED",
            failedStage: "source-sync",
            failureReason:
              row.chunksReceived === 0
                ? "No conversation history arrived from WhatsApp within the 24 hour window Meta allows."
                : "WhatsApp stopped sending history before it finished, and the 24 hour window has closed.",
          },
        });
        await recordEvent(row.id, "SOURCE_WINDOW", "FAILED", "source window expired", {
          sourceProgress: row.sourceProgress,
          chunksReceived: row.chunksReceived,
        });
        console.warn(
          `[historical-intelligence] import ${row.id} expired at ${row.sourceProgress}% (${row.chunksReceived} chunks)`,
        );
      }
    } catch (err: any) {
      console.error(`[historical-intelligence] watchdog failed: ${err?.message}`);
    }
  };
  watchdog = setInterval(tick, WATCHDOG_INTERVAL_MS);
  // `unref` so the timer never keeps the process alive during a shutdown.
  watchdog.unref?.();
  console.log("[historical-intelligence] source-window watchdog started");
}
