/**
 * Making a freshly connected integration actually usable.
 *
 * A connection can be CONNECTED, pass its capability probe, hold every scope it
 * needs - and still give the AI nothing, because the tool SURFACE is built from
 * AgentToolPermission rows and those are provisioned somewhere else entirely.
 *
 * Part 3 found the first half of this: connecting created no permissions at
 * all, so Urban Supply Dev reconnected to grant fulfillment scopes and the
 * assistant silently lost all 60-odd Shopify tools. That was fixed by calling
 * this from the connect path.
 *
 * Part 6 found the other half, the same way - by an operator reconnecting to
 * grant scopes, on the day those scopes were needed. Disconnect deletes tenant
 * tools by cascade, and the fix only ever re-granted READ tools, so after a
 * reconnect the store was healthy, the probe was green, 42 of 68 tools were
 * present, and every one of the missing 26 was a WRITE or an ACTION. The
 * assistant could look up any order and could not cancel, refund, return,
 * exchange, or change an address on one.
 *
 * That is a worse failure than having no tools, because it looks fine. The
 * reads answer every diagnostic question anyone thinks to ask, and reconnecting
 * is the ONLY way to grant a scope - so the operation a merchant performs to
 * make the assistant more capable is the operation that quietly disarms it.
 *
 * The old comment here read "Writes stay an explicit decision." That is a
 * reasonable sentence about a first connect and a false one about a reconnect:
 * nobody decided anything, a cascade did. Write and action tools are restored
 * with reads, and the thing that actually keeps them safe is where it always
 * was - `hitl_policy`, which holds every money-moving tool behind a human.
 */

import { reportOperationalFailure, ERROR_CODES } from "@chatcenter/shared";
import { prisma } from "@chatcenter/shared";

export interface ProvisionResult {
  /** Permissions newly created. */
  granted: number;
  /** Rows left alone because an operator had turned them off. */
  preserved: number;
  byCategory: Record<string, number>;
}

/**
 * Grant an integration's tools to every AI employee of the tenant.
 *
 * Idempotent, and never an upgrade of someone else's decision: a TenantTool
 * that exists with `isEnabled = false`, or an AgentToolPermission that exists
 * with `isAllowed = false`, is left exactly as it is. Only gaps are filled.
 *
 * KNOWN LIMITATION, stated rather than hidden: a full DISCONNECT deletes
 * TenantTool and AgentToolPermission by cascade, so a per-tool "off" an
 * operator set does not survive one. This function cannot preserve a row that
 * no longer exists. Reconnect therefore restores the default surface, and an
 * operator who had disabled a specific tool must disable it again. That is a
 * schema-level fix (durable per-tool intent, keyed by tenant + tool name rather
 * than by connection) and is deliberately not attempted here.
 */
export async function provisionIntegrationTools(
  tenantId: string,
  tenantIntegrationId: string,
  catalogIntegrationId: string,
  opts: { categories?: string[]; reason?: string } = {},
): Promise<ProvisionResult> {
  const empty: ProvisionResult = { granted: 0, preserved: 0, byCategory: {} };

  const tools = await prisma.catalogTool.findMany({
    where: {
      integrationId: catalogIntegrationId,
      ...(opts.categories?.length ? { category: { in: opts.categories as any } } : {}),
    },
    select: { id: true, category: true, slug: true },
  });
  if (tools.length === 0) return empty;

  const toolIds = tools.map((t) => t.id);
  const categoryById = new Map(tools.map((t) => [t.id, t.category ?? "UNKNOWN"]));

  // A TenantTool row must exist before it can be permissioned. Upsert is not
  // available here: the shared TenantGuard rejects any where clause without
  // tenantId, and the compound unique key (tenantIntegrationId, catalogToolId)
  // cannot carry one. So read what exists, then create only the gaps.
  const existingTools = await prisma.tenantTool.findMany({
    where: { tenantId, tenantIntegrationId, catalogToolId: { in: toolIds } },
    select: { id: true, catalogToolId: true, isEnabled: true },
  });
  const haveTool = new Set(existingTools.map((t) => t.catalogToolId));
  const missingTools = toolIds.filter((id) => !haveTool.has(id));
  if (missingTools.length > 0) {
    await prisma.tenantTool.createMany({
      data: missingTools.map((catalogToolId) => ({ tenantId, tenantIntegrationId, catalogToolId, isEnabled: true })),
      skipDuplicates: true,
    });
  }

  const [tenantTools, aiAgents] = await Promise.all([
    prisma.tenantTool.findMany({
      where: { tenantId, tenantIntegrationId, catalogToolId: { in: toolIds } },
      select: { id: true, catalogToolId: true, isEnabled: true },
    }),
    prisma.aIAgent.findMany({ where: { tenantId }, select: { id: true } }),
  ]);
  if (aiAgents.length === 0) return empty;

  // An operator's "off" is a decision. Skip those entirely rather than
  // creating a permission for a tool the tenant has switched off.
  const disabled = tenantTools.filter((t) => !t.isEnabled);
  const usable = tenantTools.filter((t) => t.isEnabled);

  // The unique index is [tenantToolId, departmentId, agentId] - it does NOT
  // cover aiAgentId, so an upsert keyed on the AI agent is not expressible.
  // Read what exists, then create only the gaps.
  const existing = await prisma.agentToolPermission.findMany({
    where: {
      tenantId,
      aiAgentId: { in: aiAgents.map((a) => a.id) },
      tenantToolId: { in: usable.map((t) => t.id) },
    },
    select: { aiAgentId: true, tenantToolId: true, isAllowed: true },
  });
  const seen = new Set(existing.map((p) => `${p.aiAgentId}:${p.tenantToolId}`));
  const preserved = disabled.length + existing.filter((p) => !p.isAllowed).length;

  const toCreate = aiAgents.flatMap((agent) =>
    usable
      .filter((tt) => !seen.has(`${agent.id}:${tt.id}`))
      .map((tt) => ({ tenantId, aiAgentId: agent.id, tenantToolId: tt.id, isAllowed: true, catalogToolId: tt.catalogToolId })),
  );
  if (toCreate.length === 0) return { ...empty, preserved };

  const { count } = await prisma.agentToolPermission.createMany({
    data: toCreate.map(({ catalogToolId, ...row }) => row),
    skipDuplicates: true,
  });

  const byCategory: Record<string, number> = {};
  for (const row of toCreate) {
    const c = categoryById.get(row.catalogToolId) ?? "UNKNOWN";
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }

  console.log("[integrations] tool permissions provisioned", JSON.stringify({
    tenantId, tenantIntegrationId, reason: opts.reason ?? "connect",
    catalogTools: tools.length, aiAgents: aiAgents.length,
    granted: count, preserved, byCategory,
  }));
  return { granted: count, preserved, byCategory };
}

/**
 * Grant every READ tool of an integration to every AI employee.
 *
 * Kept for the "use this integration as CRM source of truth" toggle, where
 * reads really are the whole of what that choice implies - electing a system of
 * record says the employee may see its customers, not that it may write to it.
 */
export async function enableReadToolsForIntegration(
  tenantId: string,
  tenantIntegrationId: string,
  catalogIntegrationId: string,
): Promise<number> {
  try {
    const r = await provisionIntegrationTools(tenantId, tenantIntegrationId, catalogIntegrationId, {
      categories: ["READ"],
      reason: "crm_source_of_truth",
    });
    return r.granted;
  } catch (err) {
    // The connection succeeded and the tools behind it did not. The
    // integration reads as CONNECTED in the UI while the AI has nothing it is
    // allowed to call - a state that looks fine from every direction.
    reportOperationalFailure({
      errorCode: ERROR_CODES.integration_provisioning_failed,
      domain: "integration", service: "ai",
      cause: err,
      context: { stage: "enable_read_tools", categories: "READ" },
    });
    throw err;
  }
}
