import { prisma } from "@chatcenter/shared";

/**
 * Everything that must stop being true when an integration is disconnected.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO
 * There were two teardown paths and they had drifted. The in-product
 * "Disconnect" route deleted the tenant's tool assignments; the verified
 * `app/uninstalled` webhook did not. So a merchant who uninstalled from
 * Shopify Admin - the path Shopify's own reviewers use - kept 68 tenant tool
 * rows for a store that no longer existed. Both paths now call this.
 *
 * WHAT IT DELETES, AND WHAT IT MUST NEVER TOUCH
 * It removes the TENANT'S assignments of that provider's tools
 * (`tenant_tools`), scoped by both tenant and integration. It does NOT touch
 * `catalog_tools`, which is the global catalogue every tenant shares: deleting
 * from there would remove Shopify's tools for the entire installation. The two
 * tables had the same row count on the workspace where this was found, which
 * is exactly the kind of coincidence that makes the wrong one easy to delete.
 *
 * Other tenants and other providers are untouched, because both ids are in the
 * where clause rather than just one.
 *
 * IDEMPOTENT
 * `deleteMany` on an empty set is a no-op returning 0, so a duplicate webhook
 * or a retried disconnect is safe and reports honestly how many rows it found.
 */
export async function removeTenantToolAssignments(input: {
  tenantId: string;
  tenantIntegrationId: string;
}): Promise<{ removed: number }> {
  const res = await (prisma as any).tenantTool.deleteMany({
    where: {
      // BOTH ids. Tenant alone would take their other providers' tools;
      // integration alone would reach across tenants.
      tenantId: input.tenantId,
      tenantIntegrationId: input.tenantIntegrationId,
    },
  });
  return { removed: res?.count ?? 0 };
}

/**
 * The config keys that assert a LIVE connection.
 *
 * `shopDomain` and anything else describing WHICH store this was is history
 * worth keeping; the screens label it disconnected. These describe what the
 * connection can currently DO, and a disconnected one can do nothing.
 */
export function stripLiveConnectionClaims(config: unknown): Record<string, any> {
  const next = { ...((config ?? {}) as Record<string, any>) };
  delete next.uninstallRequestedAt;
  delete next.useAsCrm;
  delete next.capabilityState;
  delete next.catalogFacets;
  return next;
}
