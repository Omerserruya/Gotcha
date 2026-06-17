/**
 * Intelligence Review queue - Customer Intelligence V2, Phase 2.
 *
 * Uncertain or conflicting extracted values are parked in `IntelligenceReview`
 * (see intelligence-ingest.decideMerge) instead of silently touching the CRM.
 * A human approves (→ the value is written as a MANUAL fact, which wins over any
 * AI value forever after) or rejects (→ discarded). This is what keeps
 * low-confidence AI guesses out of the customer record.
 */

import { prisma } from "@chatcenter/shared";

export interface ReviewDTO {
  id: string;
  entityType: "CUSTOMER" | "OPPORTUNITY" | "CONVERSATION" | "REVIEW_REQUIRED";
  entityId: string;
  fieldKey: string;
  proposedValue: unknown;
  currentValue: unknown;
  confidence: number;
  evidence: string | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  conversationId: string | null;
  createdAt: string;
}

function toDTO(r: any): ReviewDTO {
  return {
    id: r.id,
    entityType: r.entityType,
    entityId: r.entityId,
    fieldKey: r.fieldKey,
    proposedValue: r.proposedValue,
    currentValue: r.currentValue ?? null,
    confidence: r.confidence,
    evidence: r.evidence ?? null,
    reason: r.reason,
    status: r.status,
    conversationId: r.conversationId ?? null,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  };
}

export async function listPendingReviews(tenantId: string, limit = 100): Promise<ReviewDTO[]> {
  const rows = await (prisma as any).intelligenceReview.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map(toDTO);
}

export async function countPendingReviews(tenantId: string): Promise<number> {
  return (prisma as any).intelligenceReview.count({ where: { tenantId, status: "PENDING" } });
}

/**
 * Approve a review: write the proposed value as a MANUAL fact (manual supremacy
 * means it permanently wins over AI sources) and fold it into the entity
 * snapshot. Returns false if the review is missing or already resolved.
 */
export async function approveReview(tenantId: string, reviewId: string, userId?: string): Promise<boolean> {
  const r = await (prisma as any).intelligenceReview.findFirst({
    where: { id: reviewId, tenantId, status: "PENDING" },
  });
  if (!r) return false;

  const now = new Date();
  const nowIso = now.toISOString();

  // Append-only MANUAL fact = the new accepted value with provenance.
  await (prisma as any).intelligenceFact.create({
    data: {
      tenantId,
      entityType: r.entityType,
      entityId: r.entityId,
      fieldKey: r.fieldKey,
      value: r.proposedValue as any,
      confidence: 1,
      source: "MANUAL",
      evidence: r.evidence ?? null,
      observedAt: now,
      conversationId: r.conversationId ?? null,
    },
  }).catch(() => {});

  // Fold into the entity's denormalized snapshot (CONVERSATION keeps log only).
  const slot = {
    value: r.proposedValue,
    confidence: 1,
    source: "manual",
    observedAt: nowIso,
    conversationId: r.conversationId ?? null,
    evidence: r.evidence ?? null,
  };
  if (r.entityType === "CUSTOMER") {
    const prof = await (prisma as any).customerProfile.findUnique({ where: { id: r.entityId }, select: { facts: true } }).catch(() => null);
    if (prof) {
      const facts = { ...(prof.facts ?? {}), [r.fieldKey]: slot };
      await (prisma as any).customerProfile.update({ where: { id: r.entityId }, data: { facts, lastSeenAt: now } }).catch(() => {});
    }
  } else if (r.entityType === "OPPORTUNITY") {
    const opp = await (prisma as any).opportunity.findUnique({ where: { id: r.entityId }, select: { facts: true } }).catch(() => null);
    if (opp) {
      const facts = { ...(opp.facts ?? {}), [r.fieldKey]: slot };
      await (prisma as any).opportunity.update({ where: { id: r.entityId }, data: { facts, lastActivityAt: now } }).catch(() => {});
    }
  }

  await (prisma as any).intelligenceReview.update({
    where: { id: reviewId },
    data: { status: "APPROVED", resolvedAt: now, resolvedBy: userId ?? null },
  });
  return true;
}

export async function rejectReview(tenantId: string, reviewId: string, userId?: string): Promise<boolean> {
  const r = await (prisma as any).intelligenceReview.findFirst({
    where: { id: reviewId, tenantId, status: "PENDING" },
    select: { id: true },
  });
  if (!r) return false;
  await (prisma as any).intelligenceReview.update({
    where: { id: reviewId },
    data: { status: "REJECTED", resolvedAt: new Date(), resolvedBy: userId ?? null },
  });
  return true;
}
