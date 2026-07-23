/**
 * BillableEntity resolution. Money/subscription models bind to a BillableEntity,
 * never to a tenant directly (V1 = one TENANT-kind entity per tenant). This is
 * the ONLY place that bridges tenant ↔ entity, so a future BillingAccount → many
 * tenants needs no change at the call sites.
 */
import { prisma } from "@chatcenter/shared";

/** Ensure the tenant has a BillableEntity (+ link). Idempotent. Returns entity id. */
export async function ensureBillableEntity(tenantId: string): Promise<string> {
  const existing = await prisma.billableEntityTenant.findUnique({ where: { tenantId } });
  if (existing) return existing.billableEntityId;
  const entity = await prisma.billableEntity.create({ data: { kind: "TENANT" } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: entity.id, tenantId } });
  return entity.id;
}

export async function getEntityIdForTenant(tenantId: string): Promise<string | null> {
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId } });
  return link?.billableEntityId ?? null;
}

/** All tenant ids funded by a billable entity (V1: exactly one). */
export async function tenantsForEntity(entityId: string): Promise<string[]> {
  const links = await prisma.billableEntityTenant.findMany({ where: { billableEntityId: entityId } });
  return links.map((l) => l.tenantId);
}

export async function getSubscriptionForTenant(tenantId: string) {
  const entityId = await getEntityIdForTenant(tenantId);
  if (!entityId) return null;
  // Include the scheduled (not yet applied) plan change so the Billing page
  // can show "changes to X at renewal" honestly.
  return prisma.subscription.findUnique({
    where: { billableEntityId: entityId },
    include: { pendingChange: true },
  });
}
