import { Job } from "bullmq";
import {
  prisma,
  withHistoricalRecords,
  historicalIntelligenceQueue,
  type HistoricalIntelligenceJob,
} from "@chatcenter/shared";
import { runIdentityStage } from "./identity.stage";
import { runCustomerLearningStage } from "./customer-learning.stage";
import { runKnowledgeExtractionStage } from "./knowledge-extraction.stage";
import { runKnowledgeClusteringStage } from "./knowledge-clustering.stage";
import { runAnalyticsStage } from "./analytics.stage";
import { runFinalizeStage } from "./finalize.stage";
import { recordEvent } from "./stage-utils";

/**
 * The stage machine.
 *
 * Each stage is its own job. That costs a little orchestration and buys the
 * property that matters most here: a failure late in a long, expensive pipeline
 * is retried from where it broke rather than from the beginning. Re-running
 * knowledge extraction because analytics threw would mean paying for every LLM
 * call twice, and on a large import that is the difference between a retry and
 * an incident.
 *
 * Two stages are self-paced. Customer learning and knowledge extraction each
 * process a bounded batch and re-enqueue themselves while work remains, so one
 * job never runs for an unbounded time and a crash costs one batch.
 *
 * Failure keeps partial state. An import that got through ingest and customer
 * learning but broke in knowledge mining still has its messages, its linked
 * customers and its memory; the row records which stage failed so a retry
 * resumes there. Nothing here is an all-or-nothing transaction.
 */

const NEXT_STAGE: Record<HistoricalIntelligenceJob["stage"], HistoricalIntelligenceJob["stage"] | null> = {
  identity: "customer-learning",
  "customer-learning": "knowledge-extraction",
  "knowledge-extraction": "knowledge-clustering",
  "knowledge-clustering": "analytics",
  analytics: "finalize",
  finalize: null,
};

const STAGE_STATUS: Record<HistoricalIntelligenceJob["stage"], string> = {
  identity: "IDENTITY_RESOLUTION",
  "customer-learning": "CUSTOMER_LEARNING",
  "knowledge-extraction": "KNOWLEDGE_EXTRACTION",
  "knowledge-clustering": "KNOWLEDGE_CLUSTERING",
  analytics: "ANALYTICS",
  finalize: "REVIEW_READY",
};

export function processHistoricalIntelligence(job: Job<HistoricalIntelligenceJob>): Promise<void> {
  // The whole pipeline reads what the import wrote, so it opts out of the
  // live-only default once, at the boundary. See `withHistoricalRecords`.
  return withHistoricalRecords(() => runStage(job));
}

async function runStage(job: Job<HistoricalIntelligenceJob>): Promise<void> {
  const { tenantId, importId, stage } = job.data;

  const importRow = await prisma.historicalImport.findFirst({
    where: { id: importId, tenantId },
    select: { id: true, status: true },
  });
  if (!importRow) {
    console.warn(`[historical-intelligence] import ${importId} not found; dropping job`);
    return;
  }
  // A deleted or already-failed import must not be resurrected by a job that
  // was sitting in the queue when it changed.
  if (importRow.status === "FAILED" || importRow.status === "NOT_AVAILABLE") {
    console.log(`[historical-intelligence] import ${importId} is ${importRow.status}; dropping job`);
    return;
  }

  await prisma.historicalImport.updateMany({
    where: { id: importId, tenantId, status: { notIn: ["COMPLETED", "FAILED", "NOT_AVAILABLE"] } },
    data: { status: STAGE_STATUS[stage] as any },
  });

  try {
    switch (stage) {
      case "identity": {
        await runIdentityStage({ tenantId, importId });
        await enqueue(tenantId, importId, "customer-learning");
        return;
      }
      case "customer-learning": {
        const result = await runCustomerLearningStage({ tenantId, importId });
        // Self-paced: re-enqueue while customers remain, otherwise move on.
        await enqueue(tenantId, importId, result.done ? "knowledge-extraction" : "customer-learning");
        return;
      }
      case "knowledge-extraction": {
        const result = await runKnowledgeExtractionStage({ tenantId, importId });
        await enqueue(
          tenantId,
          importId,
          result.done ? "knowledge-clustering" : "knowledge-extraction",
        );
        return;
      }
      case "knowledge-clustering": {
        await runKnowledgeClusteringStage({ tenantId, importId });
        await enqueue(tenantId, importId, "analytics");
        return;
      }
      case "analytics": {
        await runAnalyticsStage({ tenantId, importId });
        await enqueue(tenantId, importId, "finalize");
        return;
      }
      case "finalize": {
        await runFinalizeStage({ tenantId, importId });
        return;
      }
    }
  } catch (err: any) {
    // BullMQ retries this job on throw. Only after the last attempt is the
    // import marked failed - failing it on the first blip would show the
    // customer an error for something that recovers thirty seconds later.
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await recordEvent(importId, STAGE_STATUS[stage], "FAILED", err?.message ?? "stage failed", {
      attempt: job.attemptsMade + 1,
      final: isLastAttempt,
    });
    if (isLastAttempt) {
      await prisma.historicalImport.updateMany({
        where: { id: importId, tenantId, status: { notIn: ["COMPLETED", "NOT_AVAILABLE"] } },
        data: {
          status: "FAILED",
          failedStage: stage,
          // The customer-facing reason. Deliberately not the raw error: the
          // stack trace is in the event row for us, and what they need to know
          // is what survived, which the results page still shows.
          failureReason: failureCopy(stage),
        },
      });
    }
    throw err;
  }
}

async function enqueue(
  tenantId: string,
  importId: string,
  stage: HistoricalIntelligenceJob["stage"] | null,
): Promise<void> {
  if (!stage) return;
  await historicalIntelligenceQueue.add(
    "stage",
    { tenantId, importId, stage },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  );
}

function failureCopy(stage: HistoricalIntelligenceJob["stage"]): string {
  switch (stage) {
    case "identity":
      return "We imported your conversations but could not finish matching them to your customers.";
    case "customer-learning":
      return "We imported your conversations but could not finish learning from them.";
    case "knowledge-extraction":
    case "knowledge-clustering":
      return "We imported your conversations but could not finish looking for reusable knowledge in them.";
    case "analytics":
      return "We imported and analyzed your conversations but could not finish the summary.";
    case "finalize":
      return "Your results are ready, but we could not send the completion email.";
  }
}

export { NEXT_STAGE };
