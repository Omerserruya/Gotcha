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
 *
 * And restoring the SURFACE is only half of it. Restoring it from catalogue
 * defaults threw away what the operator had configured, which is its own
 * customer-visible reset - a disabled `process_refund` came back enabled after
 * a reconnect. What a tool is allowed to do is a tenant decision that must
 * outlive the connection it was made through.
 */

import { prisma } from "@chatcenter/shared";
import {
  loadOperatorToolIntents,
  tenantToolFieldsFromIntent,
} from "./tool-policy-intent.service";

export interface ProvisionResult {
  /** Permissions newly created. */
  granted: number;
  /** Rows left alone because an operator had turned them off. */
  preserved: number;
  /**
   * Rows recreated from a durable operator decision rather than a catalogue
   * default. On a first connect this is zero; after a disconnect/reconnect it
   * is how many of the operator's choices were carried across.
   */
  restoredFromIntent: number;
  byCategory: Record<string, number>;
}

/**
 * Grant an integration's tools to every AI employee of the tenant.
 *
 * Idempotent, and never an upgrade of someone else's decision: a TenantTool
 * that exists with `isEnabled = false`, or an AgentToolPermission that exists
 * with `isAllowed = false`, is left exactly as it is. Only gaps are filled.
 *
 * A row that no longer exists cannot be preserved, and after a disconnect none
 * of them do. So preservation is not enough on its own: a recreated row is
 * populated from the operator's DURABLE decision in `TenantToolPermission`
 * (see `tool-policy-intent.service.ts`), which is keyed by tenant + tool name
 * and has no foreign key to any connection. Absence of a decision means nobody
 * ever configured that tool, and the catalogue default is used - which is what
 * stops this from inventing a disabled state for a tool no human has touched.
 */
export async function provisionIntegrationTools(
  tenantId: string,
  tenantIntegrationId: string,
  catalogIntegrationId: string,
  opts: { categories?: string[]; reason?: string } = {},
): Promise<ProvisionResult> {
  const empty: ProvisionResult = { granted: 0, preserved: 0, restoredFromIntent: 0, byCategory: {} };

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

  // A recreated row inherits the operator's DECISION, not the catalogue default.
  //
  // `TenantTool` dies with the connection - by cascade, and until recently by an
  // explicit delete on every disconnect. So after a disconnect/reconnect every
  // row here is "missing" and would be recreated enabled, which is exactly how
  // an operator who disabled `process_refund` got it back on. The durable
  // record in `TenantToolPermission` is what they actually chose; it has no
  // foreign key to the connection and survives.
  //
  // Absence of a record means nobody ever configured the tool, and a default is
  // legitimate. That is the distinction that stops this inventing a disabled
  // state for a tool no human has touched.
  const intents = await loadOperatorToolIntents(tenantId);
  const slugById = new Map(tools.map((t) => [t.id, t.slug]));
  let restoredFromIntent = 0;

  if (missingTools.length > 0) {
    await prisma.tenantTool.createMany({
      data: missingTools.map((catalogToolId) => {
        const intent = intents.get(String(slugById.get(catalogToolId) ?? ""));
        if (!intent) {
          return { tenantId, tenantIntegrationId, catalogToolId, isEnabled: true };
        }
        restoredFromIntent += 1;
        const fields = tenantToolFieldsFromIntent(intent);
        return {
          tenantId,
          tenantIntegrationId,
          catalogToolId,
          isEnabled: fields.isEnabled,
          configOverrides: fields.configOverrides as any,
        };
      }),
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
  if (toCreate.length === 0) return { ...empty, preserved, restoredFromIntent };

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
    granted: count, preserved, restoredFromIntent, byCategory,
  }));
  return { granted: count, preserved, restoredFromIntent, byCategory };
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
  const r = await provisionIntegrationTools(tenantId, tenantIntegrationId, catalogIntegrationId, {
    categories: ["READ"],
    reason: "crm_source_of_truth",
  });
  return r.granted;
}
