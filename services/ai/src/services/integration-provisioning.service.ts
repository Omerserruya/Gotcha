/**
 * Making a freshly connected integration actually usable.
 *
 * A connection can be CONNECTED, pass its capability probe, hold every scope
 * it needs - and still give the AI nothing, because the tool SURFACE is built
 * from AgentToolPermission rows and those are provisioned somewhere else
 * entirely. Urban Supply Dev reconnected to grant fulfillment scopes and the
 * assistant silently lost all 60-odd Shopify tools: it answered a size
 * question by asking which colour, and escalated a cancellation saying the
 * tooling was unavailable. It was telling the truth. Nothing said so anywhere.
 *
 * This lived as a private helper wired to a single UI toggle ("use as CRM").
 * It is a property of connecting, so it lives here and the OAuth callback
 * calls it too.
 */

import { prisma } from "@chatcenter/shared";

/**
 * Grant every READ tool of an integration to every AI employee of the tenant.
 *
 * Used when an integration is elected the CRM source of truth: reading the
 * system of record is implied by that choice, so the tenant should not have to
 * tick 40 boxes by hand for the employee to see its own customers.
 *
 * Idempotent, and never downgrades: rows the operator has explicitly turned
 * OFF are left alone rather than silently re-enabled on every toggle.
 * Returns the number of permissions newly granted.
 */
export async function enableReadToolsForIntegration(
  tenantId: string,
  tenantIntegrationId: string,
  catalogIntegrationId: string,
): Promise<number> {
  const readTools = await prisma.catalogTool.findMany({
    where: { integrationId: catalogIntegrationId, category: "READ" },
    select: { id: true },
  });
  if (readTools.length === 0) return 0;

  // A TenantTool row must exist before it can be permissioned. Upsert is not
  // available here: the shared TenantGuard rejects any where clause without
  // tenantId, and the compound unique key (tenantIntegrationId, catalogToolId)
  // cannot carry one. So read what exists, then create only the gaps.
  const readToolIds = readTools.map((t) => t.id);
  const existingTools = await prisma.tenantTool.findMany({
    where: { tenantId, tenantIntegrationId, catalogToolId: { in: readToolIds } },
    select: { catalogToolId: true },
  });
  const haveTool = new Set(existingTools.map((t) => t.catalogToolId));
  const missingTools = readToolIds.filter((id) => !haveTool.has(id));
  if (missingTools.length > 0) {
    await prisma.tenantTool.createMany({
      data: missingTools.map((catalogToolId) => ({ tenantId, tenantIntegrationId, catalogToolId, isEnabled: true })),
      skipDuplicates: true,
    });
  }

  const [tenantTools, aiAgents] = await Promise.all([
    prisma.tenantTool.findMany({
      where: { tenantId, tenantIntegrationId, catalogToolId: { in: readToolIds } },
      select: { id: true },
    }),
    prisma.aIAgent.findMany({ where: { tenantId }, select: { id: true } }),
  ]);
  if (aiAgents.length === 0) return 0;

  // The unique index is [tenantToolId, departmentId, agentId] - it does NOT
  // cover aiAgentId, so an upsert keyed on the AI agent is not expressible.
  // Read what exists, then create only the gaps.
  const existing = await prisma.agentToolPermission.findMany({
    where: { tenantId, aiAgentId: { in: aiAgents.map((a) => a.id) }, tenantToolId: { in: tenantTools.map((t) => t.id) } },
    select: { aiAgentId: true, tenantToolId: true },
  });
  const seen = new Set(existing.map((p) => `${p.aiAgentId}:${p.tenantToolId}`));

  const toCreate = aiAgents.flatMap((agent) =>
    tenantTools
      .filter((tt) => !seen.has(`${agent.id}:${tt.id}`))
      .map((tt) => ({ tenantId, aiAgentId: agent.id, tenantToolId: tt.id, isAllowed: true })),
  );
  if (toCreate.length === 0) return 0;

  const { count } = await prisma.agentToolPermission.createMany({ data: toCreate, skipDuplicates: true });
  console.log("[integrations] source-of-truth read tools granted", JSON.stringify({
    tenantId, tenantIntegrationId, readTools: readTools.length, aiAgents: aiAgents.length, granted: count,
  }));
  return count;
}
