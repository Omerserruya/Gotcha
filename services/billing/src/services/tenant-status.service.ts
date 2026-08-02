/**
 * Drive Tenant.status from subscription state (coupling-audit point 3): tenant
 * suspension is a CONSEQUENCE of a subscription on its BillableEntity, not of a
 * charge directly. Only toggles ACTIVE↔SUSPENDED - never touches PENDING_*
 * onboarding states. A future multi-tenant account fans one subscription to all
 * its tenants here without any call-site change.
 */
import { prisma } from "@chatcenter/shared";
import { tenantsForEntity } from "./billable-entity.service";

export async function suspendTenants(entityId: string): Promise<void> {
  const ids = await tenantsForEntity(entityId);
  if (ids.length === 0) return;
  await prisma.tenant.updateMany({ where: { id: { in: ids }, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
}

export async function unsuspendTenants(entityId: string): Promise<void> {
  const ids = await tenantsForEntity(entityId);
  if (ids.length === 0) return;
  await prisma.tenant.updateMany({ where: { id: { in: ids }, status: "SUSPENDED" }, data: { status: "ACTIVE" } });
}
