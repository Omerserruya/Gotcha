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

  const convos = await prisma.conversation.findMany({
    where: {
      tenantId,
      channel: contact.channel,
      customerExternalId: contact.externalId,
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

  const logs = await prisma.auditLog.findMany({
    where: {
      tenantId,
      actorType: "ai",
      action: { startsWith: "action." },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const recentDecisions = logs
    .filter((l) => {
      const m = (l.metadata as any) || {};
      return m?.params?.contactId === contactId;
    })
    .slice(0, 10)
    .map((l) => {
      const m = (l.metadata as any) || {};
      return {
        action: l.action,
        at: l.createdAt,
        reason: m.reason,
        riskLevel: m.riskLevel,
      };
    });

  return {
    contactId: contact.id,
    displayName: contact.displayName,
    email: contact.email,
    phone: contact.phone,
    tags: (contact.tags as string[] | null) ?? [],
    lastInteractionAt: contact.lastInteractionAt,
    recentSummaries,
    recentDecisions,
    openConversationIds,
  };
}
