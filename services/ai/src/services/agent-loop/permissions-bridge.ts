/**
 * Permissions bridge - RBAC "home" → kernel allow-list.
 *
 * The kernel's `permissions.allowedOperations` is a ceiling the Oracle
 * intersects the menu with (empty = unrestricted, by convention). This bridge
 * reads the SAME guest-list the legacy autonomous surface uses - the AND-rule:
 * AgentToolPermission.isAllowed ∧ TenantTool.isEnabled ∧ integration CONNECTED
 * (see ai-bot.service `allowedAdapterTools`) - and projects it onto kernel
 * operation names.
 *
 * Scope honesty: AgentToolPermission governs INTEGRATION (marketplace) tools
 * only. Kernel domains that are governed elsewhere keep their own gates and are
 * NEVER restricted here:
 *   - CALENDAR  → gated by calendar connection state (world facts)
 *   - KNOWLEDGE → gated by KB attachment (world facts)
 *   - CUSTOM    → gated by the tenant's custom-tool config (its own tables)
 * Only CRM-flavoured operations are tool-governed, via slug-pattern projection
 * of the allowed integration tools.
 *
 * P1-8 note: the effective-permissions endpoint reuses these two functions so
 * the UI shows EXACTLY what the runtime enforces.
 */

import { prisma } from "@chatcenter/shared";

export interface ToolGrants {
  /** True when the agent has ANY AgentToolPermission rows (RBAC configured). */
  governed: boolean;
  /** Catalog-tool slugs allowed via the AND-rule (empty when ungoverned). */
  allowedToolSlugs: Set<string>;
}

/** Read the agent's tool grants from their home. Never throws - degrades to ungoverned. */
export async function loadToolGrants(tenantId: string, aiAgentId: string): Promise<ToolGrants> {
  try {
    const [total, allowedRows] = await Promise.all([
      prisma.agentToolPermission.count({ where: { tenantId, aiAgentId } }),
      prisma.agentToolPermission.findMany({
        where: {
          tenantId,
          aiAgentId,
          isAllowed: true,
          tenantTool: { isEnabled: true, tenantIntegration: { status: "CONNECTED" } },
        },
        select: { tenantTool: { select: { catalogTool: { select: { slug: true } } } } },
      }),
    ]);
    const slugs = new Set<string>();
    for (const r of allowedRows as any[]) {
      const slug = r.tenantTool?.catalogTool?.slug;
      if (typeof slug === "string" && slug) slugs.add(slug);
    }
    return { governed: total > 0, allowedToolSlugs: slugs };
  } catch (err: any) {
    console.warn("[permissions-bridge] grant load failed (degrading to ungoverned):", err?.message);
    return { governed: false, allowedToolSlugs: new Set() };
  }
}

/** Kernel operations whose authority comes from integration-tool grants. */
const CRM_READ_OPS = ["SEARCH_CUSTOMER", "GET_CUSTOMER_CONTEXT"];
const CRM_WRITE_OPS = ["UPSERT_CUSTOMER"];
const CRM_NOTE_OPS = ["ADD_NOTE"];

const READ_SLUG = /(^|_)(search|lookup|get|find|list|describe|check)(_|$)/;
const WRITE_SLUG = /(create|update|upsert|convert)_(lead|contact|customer|record|deal|case)/;
const NOTE_SLUG = /note/;

/**
 * Project tool grants onto kernel operation names, given the operations the
 * capabilities currently expose. Pure. Returns [] (= unrestricted) when the
 * agent is ungoverned, preserving pilot behaviour for agents that pre-date the
 * permission system.
 */
export function deriveAllowedOperations(
  grants: ToolGrants,
  exposedOperations: string[],
): string[] {
  if (!grants.governed) return [];

  const slugs = [...grants.allowedToolSlugs];
  const crmGoverned = new Set<string>();
  if (slugs.some((s) => READ_SLUG.test(s))) for (const op of CRM_READ_OPS) crmGoverned.add(op);
  if (slugs.some((s) => WRITE_SLUG.test(s))) for (const op of CRM_WRITE_OPS) crmGoverned.add(op);
  if (slugs.some((s) => NOTE_SLUG.test(s))) for (const op of CRM_NOTE_OPS) crmGoverned.add(op);

  const TOOL_GOVERNED = new Set([...CRM_READ_OPS, ...CRM_WRITE_OPS, ...CRM_NOTE_OPS]);
  const allowed: string[] = [];
  for (const op of exposedOperations) {
    if (TOOL_GOVERNED.has(op)) {
      if (crmGoverned.has(op)) allowed.push(op);
      continue; // governed op without a grant → excluded from the ceiling
    }
    allowed.push(op); // governed-elsewhere domains pass through untouched
  }
  // Kernel convention: [] = unrestricted. A governed agent whose ceiling came
  // out empty must NOT be promoted to "all" - return a non-matching sentinel
  // so the menu intersection blocks everything instead.
  return allowed.length > 0 ? allowed : ["__no_operations_granted__"];
}
