/**
 * Tool-permission reconciliation.
 *
 * PROBLEM (proven): AgentToolPermission rows are seeded once, at AI-employee
 * BUILD time (agent-builder.service.ts, ai-agents.ts). They are NEVER revisited
 * when a tenant connects an integration LATER. So an employee hired before
 * Shopify was connected is frozen with a partial tool set: connecting Shopify
 * does not grant its product/order READ tools to that existing employee, even
 * though the employee's role clearly makes them eligible.
 *
 * This service closes that gap. When an integration becomes CONNECTED it, for
 * every ACTIVE AI employee, ADDS the AgentToolPermission rows the employee's
 * ROLE makes them eligible for - and ONLY those. It is:
 *
 *   - DESIRED-permission only. It never computes executable/runtime state
 *     (that is the tool-surface's job via missingScopes at buildToolSurface
 *     time). It only writes "this employee is ALLOWED this tool".
 *   - Additive & idempotent. It NEVER deletes a row and NEVER flips isAllowed
 *     on an existing row. Existing desired config is authoritative and
 *     preserved. Re-running it is a no-op once every eligible row exists.
 *   - Conservative. It grants READ tools only. WRITE / ACTION / DELETE tools
 *     (cancel_order, process_refund, coupon writers, update_customer, ...)
 *     are NEVER auto-granted - those stay an explicit human review, exactly
 *     like day-one authority in agent-builder.
 *
 * Cache note: there is NO runtime tool-surface cache to invalidate. The
 * autonomous surface (ai-bot.service `allowedAdapterTools`) and the kernel
 * bridge (agent-loop/permissions-bridge `loadToolGrants`) both read
 * AgentToolPermission FRESH from the DB every turn, so a newly-inserted row is
 * picked up on the employee's next message with no invalidation step. If a
 * cached surface is ever introduced, invalidate it at the marked point below.
 */

import { prisma } from "@chatcenter/shared";

// ─── Eligibility policy: role → eligible READ catalog-tool slugs ────────────
//
// Keyed by canonical role family. Matched against AIAgent.role (a free string:
// customer_support | sales | booking | billing | custom, plus onboarding
// variants like "sdr"). A slug listed here is granted ONLY when the connected
// tenant tool with that slug is category READ - the category check is the
// real WRITE/ACTION guard, so this map can never accidentally grant a writer.

/** Sales / SDR: product discovery + order/customer READ context. */
const SALES_READ_SLUGS = [
  "search_products",
  "get_product",
  "inventory_status",
  "variant_information",
  "get_orders",
  "find_latest_order",
  "search_orders",
  "summarize_customer",
] as const;

/** Customer support: order / refund / status READ context (NO product catalog). */
const SUPPORT_READ_SLUGS = [
  "get_orders",
  "find_latest_order",
  "search_orders",
  "order_status",
  "order_lookup",
  "track_shipment",
  "get_returns",
  "return_status",
  "summarize_customer",
] as const;

/**
 * Resolve a (free-form) AIAgent.role to its eligible READ-slug allow-set.
 * Unknown / conservative roles (booking, billing, custom) get NOTHING
 * auto-granted - they require explicit human configuration.
 */
export function eligibleReadSlugsForRole(role: string | null | undefined): Set<string> {
  const r = String(role || "").toLowerCase();
  if (r.includes("sales") || r.includes("sdr")) return new Set(SALES_READ_SLUGS);
  if (r.includes("support") || r.includes("service") || r.includes("customer_support")) {
    return new Set(SUPPORT_READ_SLUGS);
  }
  return new Set();
}

export interface ReconcileInput {
  tenantId: string;
  integrationSlug: string;
}

export interface ReconcileResult {
  /** Newly INSERTED grants, one per (agent, slug). */
  added: Array<{ agent: string; slug: string }>;
  /** Eligible grants that ALREADY existed and were left untouched (idempotency). */
  preservedExisting: number;
  /** Distinct WRITE/ACTION/DELETE slugs deliberately NOT auto-granted (guardrail evidence). */
  skippedWriteTools: string[];
}

const READ_CATEGORY = "READ";
const WRITEY_CATEGORIES = new Set(["WRITE", "ACTION", "DELETE"]);

/**
 * For `tenantId`'s newly-connected `integrationSlug`, grant each ACTIVE AI
 * employee the READ tools their role makes them eligible for that they do not
 * already have. Additive, idempotent, WRITE-safe. Never throws - degrades to a
 * no-op result on any failure so it can be called fire-and-forget from an
 * OAuth callback without blocking the redirect.
 */
export async function reconcileAgentToolPermissions(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const { tenantId, integrationSlug } = input;
  const empty: ReconcileResult = { added: [], preservedExisting: 0, skippedWriteTools: [] };

  try {
    // 1. Resolve catalog → tenant connection. Only reconcile a CONNECTED one.
    const catalog = await prisma.integrationCatalog.findUnique({
      where: { slug: integrationSlug },
      select: { id: true },
    });
    if (!catalog) return empty;

    const tenantIntegration = await prisma.tenantIntegration.findUnique({
      where: { tenantId_integrationId: { tenantId, integrationId: catalog.id } },
      select: { id: true, status: true },
    });
    if (!tenantIntegration || tenantIntegration.status !== "CONNECTED") return empty;

    // 2. Enabled tenant tools for this connection, with their catalog slug+category.
    const tenantTools = await prisma.tenantTool.findMany({
      where: { tenantId, tenantIntegrationId: tenantIntegration.id, isEnabled: true },
      select: { id: true, catalogTool: { select: { slug: true, category: true } } },
    });
    if (tenantTools.length === 0) return empty;

    // Split into eligible READ tools and blocked WRITE/ACTION tools.
    const readToolsBySlug = new Map<string, string>(); // slug -> tenantToolId
    const skippedWriteSet = new Set<string>();
    for (const tt of tenantTools as any[]) {
      const slug = tt.catalogTool?.slug;
      const category = String(tt.catalogTool?.category || "");
      if (!slug) continue;
      if (category === READ_CATEGORY) {
        readToolsBySlug.set(slug, tt.id);
      } else if (WRITEY_CATEGORIES.has(category)) {
        skippedWriteSet.add(slug);
      }
    }
    const skippedWriteTools = [...skippedWriteSet].sort();
    if (readToolsBySlug.size === 0) {
      return { added: [], preservedExisting: 0, skippedWriteTools };
    }

    // 3. ACTIVE AI employees for this tenant only (tenant isolation).
    const agents = await prisma.aIAgent.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { id: true, role: true },
    });
    if (agents.length === 0) {
      return { added: [], preservedExisting: 0, skippedWriteTools };
    }

    // 4. Existing grants for these agents on these tenant tools - so we neither
    //    duplicate nor flip them. Key: `${aiAgentId}:${tenantToolId}`.
    const tenantToolIds = [...readToolsBySlug.values()];
    const existing = await prisma.agentToolPermission.findMany({
      where: {
        tenantId,
        aiAgentId: { in: agents.map((a: any) => a.id) },
        tenantToolId: { in: tenantToolIds },
      },
      select: { aiAgentId: true, tenantToolId: true },
    });
    const existingKeys = new Set<string>(
      (existing as any[]).map((e) => `${e.aiAgentId}:${e.tenantToolId}`),
    );

    // 5. Compute the missing eligible grants, per employee role.
    const toInsert: Array<{ tenantId: string; aiAgentId: string; tenantToolId: string; isAllowed: boolean }> = [];
    const added: Array<{ agent: string; slug: string }> = [];
    let preservedExisting = 0;

    for (const agent of agents as any[]) {
      const eligibleSlugs = eligibleReadSlugsForRole(agent.role);
      if (eligibleSlugs.size === 0) continue;
      for (const slug of eligibleSlugs) {
        const tenantToolId = readToolsBySlug.get(slug);
        if (!tenantToolId) continue; // integration doesn't offer/enable this READ tool
        const key = `${agent.id}:${tenantToolId}`;
        if (existingKeys.has(key)) {
          preservedExisting++; // already desired - leave exactly as-is
          continue;
        }
        toInsert.push({ tenantId, aiAgentId: agent.id, tenantToolId, isAllowed: true });
        added.push({ agent: agent.id, slug });
        existingKeys.add(key); // guard against dup slugs mapping same tool within a role
      }
    }

    // 6. Insert missing grants. skipDuplicates is belt-and-suspenders against a
    //    concurrent reconcile racing us between the read above and this write.
    if (toInsert.length > 0) {
      await prisma.agentToolPermission.createMany({ data: toInsert, skipDuplicates: true });
    }

    // 7. Cache invalidation point (currently a no-op): the runtime tool surface
    //    reads AgentToolPermission fresh each turn, so nothing to invalidate.
    //    If a cached surface is added, clear it for `tenantId` HERE.

    return { added, preservedExisting, skippedWriteTools };
  } catch (err: any) {
    console.warn(
      `[tool-permission-reconcile] reconcile failed for tenant=${tenantId} slug=${integrationSlug}:`,
      err?.message,
    );
    return empty;
  }
}
