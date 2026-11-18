import { prisma, withHistoricalRecords } from "@chatcenter/shared";
import { platformPaidScope } from "../ai.service";
import { dropCandidateVectors } from "./candidate-index";
import { runKnowledgeExtractionStage } from "./knowledge-extraction.stage";
import { runKnowledgeClusteringStage } from "./knowledge-clustering.stage";
import { runKnowledgeDedupeStage } from "./knowledge-dedupe.stage";
import { runKnowledgeCurationStage } from "./knowledge-curation.stage";
import { runKnowledgeReviewStage } from "./knowledge-review.stage";
import { importPlatformPaid } from "./llm";
import { recordEvent } from "./stage-utils";

/**
 * Re-run ONLY the knowledge of a settled import (2026-11-18, Smoovee): the full rerun (rerunIntelligence) also
 * wipes customer memories, re-runs identity, learning, brand voice and analytics, and sends the completion email
 * again.
 *
 * - Deleted and re-created: this import's PENDING candidates and their cluster vectors (the full rerun left the
 *   vectors, so a stale one could swallow a new item). Approved and rejected candidates stay as they are.
 * - Run in this process, in order: extraction (from the first conversation), clustering, dedupe, curation, the
 *   review (cross-check and topics). Nothing else: no identity, customer learning, brand voice, analytics or
 *   finalize, so no email and no notification. The import's status is left as it is.
 * - dryRun: counts what would be deleted and changes nothing.
 */
export interface KnowledgeRerunResult {
  ok: boolean;
  reason?: string;
  dryRun: boolean;
  pendingDeleted: number;
  kept: number;
  extractionBatches?: number;
  candidatesAfter?: number;
}

export async function rerunKnowledgeOnly(args: { tenantId: string; importId: string; dryRun?: boolean; maxBatches?: number }): Promise<KnowledgeRerunResult> {
  const { tenantId, importId } = args;
  const dryRun = !!args.dryRun;
  return withHistoricalRecords(async () => {
    const row = await prisma.historicalImport.findFirst({ where: { id: importId, tenantId }, select: { id: true, status: true, sourceProgress: true } });
    if (!row) return { ok: false, reason: "Import not found.", dryRun, pendingDeleted: 0, kept: 0 };
    if (!["COMPLETED", "REVIEW_READY", "FAILED"].includes(row.status) || row.sourceProgress !== 100) {
      return { ok: false, reason: `Import is ${row.status} at ${row.sourceProgress}%: only a settled import is rerun.`, dryRun, pendingDeleted: 0, kept: 0 };
    }
    const pending = await prisma.knowledgeCandidate.findMany({ where: { tenantId, importId, status: "PENDING" }, select: { id: true } });
    const kept = await prisma.knowledgeCandidate.count({ where: { tenantId, importId, status: { not: "PENDING" } } });
    if (dryRun) return { ok: true, dryRun, pendingDeleted: pending.length, kept };

    const ids = pending.map((c) => c.id);
    // Vectors first: a vector without its row is what loses items on the rerun.
    for (let i = 0; i < ids.length; i += 200) await dropCandidateVectors(tenantId, ids.slice(i, i + 200));
    await prisma.$transaction([
      prisma.knowledgeCandidate.deleteMany({ where: { tenantId, importId, status: "PENDING" } }),
      // Extraction resumes from its own events: without them it starts at the first conversation again.
      prisma.historicalImportEvent.deleteMany({ where: { importId, step: "KNOWLEDGE_EXTRACTION" } }),
    ]);
    await recordEvent(importId, "KNOWLEDGE_RERUN", "SUCCESS", "knowledge-only rerun started", { pendingDeleted: ids.length, kept });

    const run = async () => {
      let batches = 0;
      const max = args.maxBatches ?? 1000;
      for (;;) {
        const r = await runKnowledgeExtractionStage({ tenantId, importId });
        batches++;
        if (r.done || batches >= max) break;
      }
      await runKnowledgeClusteringStage({ tenantId, importId });
      await runKnowledgeDedupeStage({ tenantId, importId });
      await runKnowledgeCurationStage({ tenantId, importId });
      await runKnowledgeReviewStage({ tenantId, importId });
      return batches;
    };
    const extractionBatches = importPlatformPaid() ? await platformPaidScope.run({ reason: "historical_import" }, run) : await run();
    const candidatesAfter = await prisma.knowledgeCandidate.count({ where: { tenantId, importId, status: "PENDING" } });
    await recordEvent(importId, "KNOWLEDGE_RERUN", "SUCCESS", "knowledge-only rerun finished", { extractionBatches, candidatesAfter });
    return { ok: true, dryRun, pendingDeleted: ids.length, kept, extractionBatches, candidatesAfter };
  });
}
