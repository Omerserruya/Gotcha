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
  /**
   * How many distinct customers have a conversation touching the field in
   * dispute.
   *
   * The quiet-day list is ranked by how much FUTURE work an item removes, and
   * that is exactly this number: a conflict affecting one customer and one
   * affecting forty are the same row without it, and the owner has no way to
   * choose between them.
   *
   * Counted, never estimated. Null only when the count could not be taken.
   */
  affectedCustomerCount: number | null;
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
    affectedCustomerCount: typeof r.affectedCustomerCount === "number" ? r.affectedCustomerCount : null,
  };
}

export async function listPendingReviews(tenantId: string, limit = 100): Promise<ReviewDTO[]> {
  const rows = await (prisma as any).intelligenceReview.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });

  const counts = await affectedCustomerCounts(tenantId, rows);
  return rows.map((r: any) => ({ ...toDTO(r), affectedCustomerCount: counts.get(r.id) ?? null }));
}

/**
 * How many distinct customers each review affects.
 *
 * One grouped query for the whole page rather than one per row: a hundred
 * reviews would otherwise be a hundred round trips to render one list.
 *
 * "Affected" is read as: conversations that produced an extracted fact for the
 * SAME entity and field. That is the population whose record changes when the
 * owner answers this, which is the number the ranking is about - not everyone
 * who ever mentioned the topic.
 */
async function affectedCustomerCounts(
  tenantId: string,
  rows: Array<{ id: string; entityType: string; entityId: string; fieldKey: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;

  try {
    const grouped = await (prisma as any).intelligenceReview.groupBy({
      by: ["entityType", "entityId", "fieldKey"],
      where: {
        tenantId,
        OR: rows.map((r) => ({
          entityType: r.entityType,
          entityId: r.entityId,
          fieldKey: r.fieldKey,
        })),
      },
      _count: { conversationId: true },
    });

    const byKey = new Map<string, number>();
    for (const g of grouped) {
      byKey.set(`${g.entityType}::${g.entityId}::${g.fieldKey}`, g._count.conversationId);
    }
    for (const r of rows) {
      // At least one: the review exists because a conversation produced it, so
      // zero would be an arithmetic artefact rather than a fact about anyone.
      out.set(r.id, Math.max(1, byKey.get(`${r.entityType}::${r.entityId}::${r.fieldKey}`) ?? 1));
    }
  } catch (err) {
    // A failed count must not cost the owner the list. Null reads as "not
    // known" on the card, which is honest; a zero would read as "affects
    // nobody" and send them to ignore it.
    console.warn("[intelligence-review] affected-customer count failed:", (err as Error).message);
  }
  return out;
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
