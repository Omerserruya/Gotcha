import { prisma, writeAudit, AuditAction } from "@chatcenter/shared";
import { processDocument } from "../embedding.service";
import { findExistingKnowledge } from "./candidate-index";
import { autoApprovable, unresolvedConflict, humanSourcedIds, autoApproveEnabled } from "./knowledge-review.stage";

/** Moved out of routes/historical-import.ts (2026-11-18) so the auto-approve step shares the very same path. */
/**
 * The KB document body for an approved suggestion.
 *
 * The reasoning is part of the document, not metadata, because it has to reach
 * the model the same way the answer does - through retrieval. A document that
 * carries only the rule answers the question it was mined from and fails the
 * next variation of it, which is the whole difference between an FAQ and
 * knowing the job. Labelled so the model reads it as background rather than as
 * something to recite back to the customer.
 */
export function knowledgeDocumentBody(
  question: string,
  answer: string,
  reasoning: string | null,
  requiresLiveLookup = false,
): string {
  const parts = [question.trim(), "", answer.trim()];
  if (requiresLiveLookup) {
    // Inside the document, not in metadata, because only what is in the body
    // reaches the model through retrieval. Without it an agent reads "usually
    // Thursday and Friday" and promises a slot nobody checked.
    parts.push(
      "",
      "This depends on live availability. Treat it as the usual pattern, not a commitment: check the calendar or current stock before telling a customer anything specific.",
    );
  }
  if (reasoning && reasoning.trim()) {
    parts.push("", `How we approach this: ${reasoning.trim()}`);
  }
  return parts.join("\n");
}

/**
 * Where an approved suggestion lands.
 *
 * The explicitly chosen base if the caller named one, otherwise the tenant's
 * first active general-scope base. Never creates one: a knowledge base is a
 * deliberate object with a name and a scope, and manufacturing one as a side
 * effect of an approval would put the customer's knowledge somewhere they never
 * chose.
 */
export async function resolveTargetKnowledgeBase(
  tenantId: string,
  requestedId?: unknown,
): Promise<{ id: string } | null> {
  if (typeof requestedId === "string" && requestedId) {
    const explicit = await prisma.knowledgeBase.findFirst({
      where: { id: requestedId, tenantId, isActive: true },
      select: { id: true },
    });
    if (explicit) return explicit;
  }
  return prisma.knowledgeBase.findFirst({
    where: { tenantId, isActive: true, scope: "all" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/**
 * The single-candidate approval used by the bulk path.
 *
 * Shares the duplicate check and the provenance stamping with the single
 * endpoint above, so a bulk approve cannot take a shortcut the individual one
 * refuses.
 */
/** Why a candidate was not found: a conflicted one needs a person's answer. */
const candidateIdConflictHint = (opts: { auto?: boolean }, sent: string | null) => (opts.auto || sent ? "not eligible" : "not eligible (a conflict needs an answer)");

export async function approveOne(
  tenantId: string,
  candidateId: string,
  userId: string,
  /**
   * auto: the auto-approve step (2026-11-18). A conflict the newest person answer settled is no bar there; an
   * unsettled one still is. The audit says it was automatic, decidedBy "auto".
   */
  opts: {
    auto?: boolean;
    /** A person's answer for this item (approve-a-topic): an edit when it differs; it settles a conflict. */
    answer?: string | null;
    /** The topic's import: the candidate must belong to it. */
    importId?: string;
  } = {},
): Promise<{ ok: boolean; reason?: string; documentId?: string }> {
  const sent = typeof opts.answer === "string" && opts.answer.trim() ? opts.answer.trim() : null;
  if (sent && sent.length > 4000) return { ok: false, reason: "answer too long" };
  const candidate = await prisma.knowledgeCandidate.findFirst({
    where: { id: candidateId, tenantId, status: "PENDING", ...(opts.importId ? { importId: opts.importId } : {}), ...(opts.auto || sent ? {} : { conflict: false }) },
  });
  if (!candidate) return { ok: false, reason: candidateIdConflictHint(opts, sent) };
  if (opts.auto && unresolvedConflict(candidate as any)) return { ok: false, reason: "unresolved conflict" };
  const editedAnswer = sent && sent !== String(candidate.answer ?? "").trim() ? sent : null;
  const finalAnswer = editedAnswer ?? candidate.answer;

  const target = await resolveTargetKnowledgeBase(tenantId);
  if (!target) return { ok: false, reason: "no knowledge base" };

  const existing = await findExistingKnowledge({
    tenantId,
    question: candidate.question,
    answer: finalAnswer,
  });
  if (existing) {
    await prisma.knowledgeCandidate.updateMany({
      where: { id: candidate.id, tenantId },
      data: { status: "SUPERSEDED", duplicateOfDocumentId: existing.documentId },
    });
    return { ok: false, reason: "already covered" };
  }

  const document = await prisma.knowledgeDocument.create({
    data: {
      knowledgeBaseId: target.id,
      tenantId,
      title: candidate.question.slice(0, 200),
      content: knowledgeDocumentBody(candidate.question, finalAnswer, candidate.reasoning, candidate.requiresLiveLookup),
      sourceType: "historical_conversations",
      status: "pending",
      metadata: {
        origin: "historical_import",
        sourceType: "historical_conversations",
        topic: candidate.topic,
      },
    },
  });

  await prisma.knowledgeCandidate.updateMany({
    where: { id: candidate.id, tenantId },
    data: {
      status: "APPROVED",
      ...(editedAnswer ? { editedAnswer } : {}),
      approvedDocumentId: document.id,
      decidedAt: new Date(),
      decidedBy: opts.auto ? "auto" : userId,
    },
  });

  try {
    await processDocument(document.id);
  } catch (err: any) {
    console.error(`[historical-import] embedding failed for ${document.id}: ${err?.message}`);
  }

  await writeAudit({
    tenantId,
    actorType: opts.auto ? "system" : "user",
    actorId: opts.auto ? "auto" : userId,
    action: AuditAction.KNOWLEDGE_HISTORICAL_APPROVED,
    targetType: "knowledge_document",
    targetId: document.id,
    metadata: {
      source: "historical_conversations",
      sourceProvider: "whatsapp_business_app",
      candidateId: candidate.id,
      ...(opts.auto ? { auto: true, occurrenceCount: candidate.occurrenceCount, curationVerdict: candidate.curationVerdict } : opts.importId ? { topic: true, edited: !!editedAnswer } : { bulk: true }),
    },
  });

  return { ok: true, documentId: document.id };
}



/**
 * The auto-approve step (2026-11-18, Omer approved): every PENDING candidate of the import that autoApprovable()
 * says yes to (a person's answer, 3+, no unsettled conflict, no document contradiction, kept or rewritten, not
 * live data) is approved through approveOne, the same path as a person's bulk approve: a knowledge document,
 * the duplicate check (already covered = SUPERSEDED, not approved), the embedding and the audit, decidedBy "auto".
 * dryRun: the count and the ids, nothing written. Runs only when HISTORICAL_IMPORT_AUTO_APPROVE is on, unless
 * force (the script's explicit run).
 */
export async function autoApproveImport(args: { tenantId: string; importId: string; dryRun?: boolean; force?: boolean }): Promise<{
  enabled: boolean; dryRun: boolean; eligible: number; approved: number; skipped: Record<string, number>; ids: string[];
}> {
  const { tenantId, importId } = args;
  const dryRun = !!args.dryRun;
  const enabled = autoApproveEnabled() || !!args.force;
  const candidates = await prisma.knowledgeCandidate.findMany({
    where: { tenantId, importId, status: "PENDING" },
    select: { id: true, occurrenceCount: true, conflict: true, variants: true, curationVerdict: true, curationNote: true, requiresLiveLookup: true },
  });
  const evidence = await prisma.knowledgeCandidateEvidence.findMany({
    where: { tenantId, candidateId: { in: candidates.map((c) => c.id) }, representative: true },
    select: { candidateId: true, conversationId: true, questionText: true, answerText: true, occurredAt: true },
  });
  const human = await humanSourcedIds(tenantId, evidence);
  const ids = candidates.filter((c) => autoApprovable({ ...c, humanSourced: human.has(c.id) })).map((c) => c.id);
  const skipped: Record<string, number> = {};
  let approved = 0;
  if (!dryRun && enabled) {
    for (const id of ids) {
      const r = await approveOne(tenantId, id, "auto", { auto: true });
      if (r.ok) approved++;
      else skipped[r.reason ?? "unknown"] = (skipped[r.reason ?? "unknown"] ?? 0) + 1;
    }
  }
  return { enabled, dryRun, eligible: ids.length, approved, skipped, ids };
}
