import { prisma } from "@chatcenter/shared";
import { findExistingKnowledge } from "./candidate-index";
import { recordEvent, mapLimited, type StageResult } from "./stage-utils";

/**
 * The pass that decides which candidates are worth a person's attention.
 *
 * Extraction already merged duplicates into clusters. What is left are three
 * judgements that can only be made once every conversation has been seen:
 *
 *   1. How much evidence is behind each candidate.
 *   2. Whether the knowledge base already says it.
 *   3. Whether the business contradicted itself.
 *
 * ── On confidence ──
 *
 * Confidence here means ONE thing: how consistently we observed this answer.
 * It does not mean the answer is right. Human agents make mistakes, grant
 * one-off exceptions and quote policies that changed two years ago, and a
 * hundred conversations repeating an outdated returns window is a hundred
 * pieces of evidence for something that is no longer true. The review UI says
 * so in those words, because a number labelled "confidence" invites exactly the
 * opposite reading.
 *
 * The score is computed arithmetically from counts rather than asked of a
 * model. Asking an LLM how confident it is produces a number with no defined
 * meaning that cannot be reproduced, audited or explained to the person being
 * asked to trust it.
 */

const CONCURRENCY = 3;

/**
 * There is no occurrence floor, and that is the point.
 *
 * This stage used to delete every candidate seen fewer than twice. The
 * reasoning was that one-offs bury the real knowledge in the review queue, and
 * the queue-noise problem was real - but the cure removed the wrong half. On
 * the largest import to date, 37,856 messages produced 21 review items, and 23
 * genuine singletons were deleted to get there: "do you deliver to Eilat",
 * "can I collect on a Saturday", each asked once, each true for everyone who
 * asks next.
 *
 * Frequency answers "how common is this", and the question that decides whether
 * knowledge is worth keeping is "would this serve a different customer". That
 * is a property of the text, and it is now enforced at extraction time by
 * `judgeSpecificity` - deterministically, with a stated reason, on every item.
 * What reaches this stage has already been found reusable, so deleting it for
 * being rare would discard exactly the knowledge nobody has written down.
 *
 * Frequency still matters, but as a SORT rather than a FILTER: `confidence`
 * below scores how consistently an answer was observed, so the review queue
 * leads with the well-evidenced items and the singletons sit beneath them
 * instead of being destroyed.
 */

export async function runKnowledgeClusteringStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const candidates = await prisma.knowledgeCandidate.findMany({
    where: { importId, tenantId, status: "PENDING" },
    select: {
      id: true,
      question: true,
      answer: true,
      occurrenceCount: true,
      customerCount: true,
      conflict: true,
      variants: true,
    },
  });

  let alreadyCovered = 0;
  let conflicts = 0;
  let kept = 0;

  await mapLimited(candidates, CONCURRENCY, async (candidate) => {
    // ── Does the knowledge base already say this? ──
    const existing = await findExistingKnowledge({
      tenantId,
      question: candidate.question,
      answer: candidate.answer,
    });

    if (existing) {
      await prisma.knowledgeCandidate.updateMany({
        where: { id: candidate.id, tenantId, status: "PENDING" },
        data: {
          status: "SUPERSEDED",
          duplicateOfDocumentId: existing.documentId,
          confidence: scoreConfidence(candidate),
        },
      });
      alreadyCovered += 1;
      return;
    }

    const confidence = scoreConfidence(candidate);
    await prisma.knowledgeCandidate.updateMany({
      where: { id: candidate.id, tenantId, status: "PENDING" },
      data: { confidence },
    });
    if (candidate.conflict) conflicts += 1;
    kept += 1;
  });

  const [finalCount, finalConflicts] = await Promise.all([
    prisma.knowledgeCandidate.count({ where: { importId, tenantId, status: "PENDING" } }),
    prisma.knowledgeCandidate.count({
      where: { importId, tenantId, status: "PENDING", conflict: true },
    }),
  ]);

  await prisma.historicalImport.update({
    where: { id: importId },
    data: {
      knowledgeCandidateCount: finalCount,
      knowledgeConflictCount: finalConflicts,
      status: "ANALYTICS",
    },
  });

  const detail = {
    examined: candidates.length,
    kept,
    alreadyCovered,
    conflicts,
    finalCount,
    finalConflicts,
  };
  await recordEvent(
    importId,
    "KNOWLEDGE_CLUSTERING",
    "SUCCESS",
    null,
    detail,
    Date.now() - startedAt,
  );

  return { ok: true, detail };
}

/**
 * How consistently this answer was observed, from 0 to 1.
 *
 * Three inputs, in order of weight:
 *
 *   * How many distinct customers were told it. Ten customers hearing the same
 *     thing is far stronger evidence than one customer hearing it ten times.
 *   * How many times in total.
 *   * Whether the business ever said something different. A contradiction is a
 *     hard cap, not a small penalty: the moment two answers exist, no amount of
 *     repetition makes either one "confirmed", and letting a conflicted item
 *     score high would put it inside the bulk-approve threshold.
 *
 * Both counts are compressed logarithmically. The difference between two
 * customers and twenty is real; the difference between two hundred and four
 * hundred is not, and a linear scale would let one very common question drown
 * out everything else.
 */
export function scoreConfidence(c: {
  occurrenceCount: number;
  customerCount: number;
  conflict: boolean;
}): number {
  const customers = Math.max(1, c.customerCount);
  const occurrences = Math.max(1, c.occurrenceCount);

  // log10 scaled so 10 distinct customers reaches the top of the customer term.
  const customerTerm = Math.min(1, Math.log10(customers + 1) / Math.log10(11));
  const occurrenceTerm = Math.min(1, Math.log10(occurrences + 1) / Math.log10(21));

  const base = 0.65 * customerTerm + 0.35 * occurrenceTerm;

  // The cap sits below the bulk-approve threshold on purpose, so a conflicted
  // candidate can never be swept in by "approve all high confidence".
  return c.conflict ? Math.min(base, 0.45) : Number(base.toFixed(3));
}

/**
 * The threshold above which an item may be included in a bulk approve.
 *
 * Exported so the UI, the API and the tests all read the same number. A bulk
 * action whose meaning differs between the button and the endpoint is worse
 * than no bulk action.
 */
export const BULK_APPROVE_MIN_CONFIDENCE = 0.7;
