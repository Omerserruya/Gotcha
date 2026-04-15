import { prisma } from "@chatcenter/shared";

/**
 * F7.2 — Customer "state object" builder.
 *
 * Aggregates a compact, LLM-ready view of a customer across recent
 * conversations + intelligence records + audit trail. Pulls ONLY from
 * services' read models — no cross-service joins, no direct DB access
 * to other domains (per CLAUDE.md Service Ownership boundary).
 *
 * F7.5 — Decision history is derived from AuditLog entries with
 * actorType="ai" targeting conversations/contacts for this customer.
 */
export interface CustomerState {
  contactId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  lastInteractionAt: Date | null;
  recentSummaries: Array<{ conversationId: string; summary: string | null; updatedAt: Date }>;
  recentDecisions: Array<{ action: string; at: Date; reason?: string; riskLevel?: string }>;
  openConversationIds: string[];
}

export async function buildCustomerState(
  tenantId: string,
  contactId: string,
): Promise<CustomerState | null> {
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
  if (!contact) return null;

  // Follow soft-merge pointer if the caller passed a merged-away id
  const effective = contact.mergedIntoId
    ? (await prisma.contact.findFirst({ where: { id: contact.mergedIntoId, tenantId } })) ?? contact
    : contact;

  // Cross-channel: gather all contact rows that belong to the same real
  // person (personId match, or legacy email/phone fallback). Previously
  // this query was per-(channel, externalId), so a WA contact view would
  // miss the same person's IG and Gmail history entirely.
  const { findSiblingContacts } = await import("@chatcenter/shared");
  const siblings = await findSiblingContacts(tenantId, effective);

  const convos = await prisma.conversation.findMany({
    where: {
      tenantId,
      OR: siblings.map((s) => ({ channel: s.channel, customerExternalId: s.externalId })),
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
    include: { intelligence: true },
  });

  const recentSummaries = convos
    .map((c) => ({
      conversationId: c.id,
      summary: c.aiSummary ?? c.intelligence?.summary ?? null,
      updatedAt: c.updatedAt,
    }))
    .filter((s) => s.summary);

  const openConversationIds = convos.filter((c) => c.status === "OPEN").map((c) => c.id);

  // Pull AI decisions across ALL sibling contacts, not just the single
  // row the caller passed in. Same cross-channel logic as the summaries
  // query above — a decision taken on the IG contact row should show up
  // in the customer state fetched via the WA contact row.
  const indexedLogs = await prisma.auditLog.findMany({
    where: {
      tenantId,
      actorType: "ai",
      targetType: "contact",
      targetId: { in: siblings.map((s) => s.id) },
      action: { startsWith: "action." },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const recentDecisions = indexedLogs.map((l) => {
    const m = (l.metadata as any) || {};
    return {
      action: l.action,
      at: l.createdAt,
      reason: m.reason,
      riskLevel: m.riskLevel,
    };
  });

  return {
    contactId: effective.id,
    displayName: effective.displayName,
    email: effective.email,
    phone: effective.phone,
    tags: (effective.tags as string[] | null) ?? [],
    lastInteractionAt: effective.lastInteractionAt,
    recentSummaries,
    recentDecisions,
    openConversationIds,
  };
}
