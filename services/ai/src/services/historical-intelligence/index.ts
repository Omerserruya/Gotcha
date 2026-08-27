import { Job } from "bullmq";
import { Prisma } from "@prisma/client";
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
import { runKnowledgeDedupeStage } from "./knowledge-dedupe.stage";
import { runKnowledgeCurationStage } from "./knowledge-curation.stage";
import { runBrandVoiceStage } from "./brand-voice.stage";
import { runAnalyticsStage } from "./analytics.stage";
import { runFinalizeStage } from "./finalize.stage";
import { recordEvent } from "./stage-utils";
import { dropImportClusters } from "./candidate-index";

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

/**
 * The stage order, and the ONLY place it is written down.
 *
 * This table used to sit beside a switch statement that enqueued the next stage
 * by name, which is two sources of truth for one fact. Adding the curation stage
 * updated the table and not the switch, so dedupe kept handing straight to
 * brand-voice: the stage existed, was deployed, was verified present in the
 * container, and simply never ran. Nothing failed, no event was written, and the
 * import completed successfully without it.
 *
 * Every case now advances via `NEXT_STAGE[stage]`. A self-paced stage passes
 * `stage` to re-enqueue itself. Inserting a stage is a one-line change here.
 */
const NEXT_STAGE: Record<HistoricalIntelligenceJob["stage"], HistoricalIntelligenceJob["stage"] | null> = {
  identity: "customer-learning",
  "customer-learning": "knowledge-extraction",
  "knowledge-extraction": "knowledge-clustering",
  "knowledge-clustering": "knowledge-dedupe",
  "knowledge-dedupe": "knowledge-curation",
  "knowledge-curation": "brand-voice",
  "brand-voice": "analytics",
  analytics: "finalize",
  finalize: null,
};

const STAGE_STATUS: Record<HistoricalIntelligenceJob["stage"], string> = {
  identity: "IDENTITY_RESOLUTION",
  "customer-learning": "CUSTOMER_LEARNING",
  "knowledge-extraction": "KNOWLEDGE_EXTRACTION",
  "knowledge-clustering": "KNOWLEDGE_CLUSTERING",
  "knowledge-dedupe": "KNOWLEDGE_CLUSTERING",
  // No status of its own: the stage is short and adding one would mean a new
  // enum value, a new progress band and a new label in two languages for
  // something the customer sees for under a minute.
  "knowledge-curation": "KNOWLEDGE_CLUSTERING",
  "brand-voice": "ANALYTICS",
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
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
        return;
      }
      case "customer-learning": {
        const result = await runCustomerLearningStage({ tenantId, importId });
        // Self-paced: re-enqueue while customers remain, otherwise move on.
        await enqueue(tenantId, importId, result.done ? NEXT_STAGE[stage] : stage);
        return;
      }
      case "knowledge-extraction": {
        const result = await runKnowledgeExtractionStage({ tenantId, importId });
        await enqueue(tenantId, importId, result.done ? NEXT_STAGE[stage] : stage);
        return;
      }
      case "knowledge-clustering": {
        await runKnowledgeClusteringStage({ tenantId, importId });
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
        return;
      }
      // Same question, different words. Embeddings cannot separate Hebrew
      // paraphrase from genuinely different questions at any single threshold
      // (measured: 0.42 for two phrasings of "how long is delivery"), so a
      // language model merges the survivors - tens of items, one call, after
      // pruning rather than during extraction.
      case "knowledge-dedupe": {
        await runKnowledgeDedupeStage({ tenantId, importId });
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
        return;
      }
      // How the business writes, counted from its own outbound messages and
      // rendered into the system prompt every agent runs with.
      // The polish pass. Runs after dedupe so it sees the merged set, and
      // before analytics so the topic counts describe what survived.
      case "knowledge-curation": {
        await runKnowledgeCurationStage({ tenantId, importId });
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
        return;
      }
      case "brand-voice": {
        await runBrandVoiceStage({ tenantId, importId });
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
        return;
      }
      case "analytics": {
        await runAnalyticsStage({ tenantId, importId });
        await enqueue(tenantId, importId, NEXT_STAGE[stage]);
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
    case "knowledge-dedupe":
    case "knowledge-curation":
      return "We imported your conversations but could not finish looking for reusable knowledge in them.";
    case "brand-voice":
      return "We imported and analyzed your conversations but could not finish learning how you write.";
    case "analytics":
      return "We imported and analyzed your conversations but could not finish the summary.";
    case "finalize":
      return "Your results are ready, but we could not send the completion email.";
  }
}

/**
 * Wipe everything the intelligence stages produced and run them again over the
 * already-imported conversations.
 *
 * This exists because the STAGES can be wrong while the DATA is fine - the
 * first live import mined another business's auto-replies as this business's
 * policy, and the customer memories drew on the same mislabeled threads. Meta
 * grants ONE history sync per onboarding, so "delete the import and reconnect"
 * is not an option; the raw Conversation/Message rows are the one thing that
 * must survive. This deletes only derived artifacts:
 *
 *   - customer memories (CustomerHistoricalMemory)
 *   - knowledge candidates + their evidence (cascade)
 *   - the import's Qdrant cluster vectors
 *   - per-customer learning progress (back to PENDING)
 *   - the KNOWLEDGE_EXTRACTION progress events - the extraction stage pages by
 *     summing them, so stale ones would make the rerun skip conversations
 *
 * Candidates a human already APPROVED have their knowledge documents left
 * untouched - the approval was a person's decision; the rerun only regenerates
 * what was still a machine suggestion.
 */
export async function rerunIntelligence(args: {
  tenantId: string;
  importId: string;
}): Promise<{ ok: true; deleted: { memories: number; candidates: number } } | { ok: false; reason: string }> {
  const { tenantId, importId } = args;
  return withHistoricalRecords(async () => {
    const row = await prisma.historicalImport.findFirst({
      where: { id: importId, tenantId },
      select: { id: true, status: true, sourceProgress: true, chunksReceived: true },
    });
    if (!row) return { ok: false as const, reason: "Import not found." };
    // Only once the source data is fully on disk. A rerun racing ingest would
    // analyze half a history and record the result as complete.
    const settled = ["COMPLETED", "REVIEW_READY", "FAILED"].includes(row.status);
    if (!settled || row.sourceProgress !== 100) {
      return { ok: false as const, reason: `Import is ${row.status} at ${row.sourceProgress}% - it can be rerun only after it settles.` };
    }

    const [memories, candidates] = await prisma.$transaction([
      prisma.customerHistoricalMemory.deleteMany({ where: { tenantId, importId } }),
      prisma.knowledgeCandidate.deleteMany({ where: { tenantId, importId } }),
      prisma.historicalCustomer.updateMany({
        where: { tenantId, importId },
        data: { learningStatus: "PENDING" },
      }),
      prisma.historicalImportEvent.deleteMany({
        where: { importId, step: "KNOWLEDGE_EXTRACTION" },
      }),
      prisma.historicalImport.update({
        where: { id: importId },
        data: {
          status: "IDENTITY_RESOLUTION",
          customersAnalyzed: 0,
          // Both halves of the progress bar have to reset together. Leaving
          // these at the previous run's totals made the bar read 85% the
          // instant extraction started and then fall back to 54% once the
          // first batch wrote the real count - progress going backwards, which
          // is the one thing a progress bar must never do.
          conversationsExtracted: 0,
          conversationsEligible: 0,
          knowledgeCandidateCount: 0,
          knowledgeConflictCount: 0,
          topTopics: Prisma.DbNull,
          summary: Prisma.DbNull,
          // Derived like everything else here, so a rerun regenerates it. The
          // tenant's `observedVoice` is deliberately NOT cleared: the rerun's
          // brand-voice stage overwrites it, and blanking it first would leave
          // every agent with no voice for as long as the rerun takes.
          brandVoice: Prisma.DbNull,
          intelligenceStartedAt: new Date(),
          reviewReadyAt: null,
          completedAt: null,
          // Released so the rerun's finalize can send a fresh completion email.
          completionEmailSentAt: null,
          failedStage: null,
          failureReason: null,
        },
      }),
    ]);

    await dropImportClusters(tenantId, importId);
    await recordEvent(importId, "IDENTITY_RESOLUTION", "SUCCESS", "intelligence rerun requested", {
      deletedMemories: memories.count,
      deletedCandidates: candidates.count,
    });
    await enqueue(tenantId, importId, "identity");

    return { ok: true as const, deleted: { memories: memories.count, candidates: candidates.count } };
  });
}

export { NEXT_STAGE };
