/**
 * Recipient resolver for the notification engine.
 *
 * Given a NotificationPreference's `recipients` spec and a SystemEvent,
 * resolves a deduped list of `User` rows that should be notified.
 *
 * Codebase mapping:
 *   - The `Role` enum is { SYSTEM_ADMIN, ADMIN, AGENT } - there is no OWNER.
 *     We treat ADMIN as the closest analogue (tenant-level admin = owner).
 *     SYSTEM_ADMIN is the platform operator and is intentionally excluded
 *     from tenant-scoped notifications.
 *   - Department managers: there is no `Department.managerId` column. We
 *     resolve via DepartmentMember.departmentRole = "MANAGER" instead.
 *   - The `users` spec is filtered by tenant_id for safety so cross-tenant
 *     leakage is impossible even if a stale userId sneaks in.
 *
 * All queries are tenantId-scoped.
 */

import { prisma } from "@chatcenter/shared";

export type RecipientType = "tenant_owner" | "department_manager" | "users";

export interface RecipientSpec {
  type: RecipientType;
  userIds?: string[];
}

export interface ResolvedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  notificationSoundEnabled: boolean;
}

export async function resolveRecipients(opts: {
  tenantId: string;
  departmentId?: string;
  spec: RecipientSpec;
}): Promise<ResolvedUser[]> {
  const { tenantId, departmentId, spec } = opts;
  const out = new Map<string, ResolvedUser>();

  if (spec.type === "tenant_owner") {
    // Tenant "owner" maps to ADMIN role in this codebase.
    const admins = await (prisma as any).user.findMany({
      where: { tenantId, role: "ADMIN", isActive: true },
      select: { id: true, tenantId: true, email: true, name: true, notificationSoundEnabled: true },
    });
    for (const u of admins) out.set(u.id, u);
  } else if (spec.type === "department_manager") {
    // Resolve department managers via DepartmentMember.departmentRole.
    if (!departmentId) {
      // Fallback: when the event has no department context, all department
      // managers across the tenant. The dispatcher should normally filter to
      // event.departmentId; this branch is a safety net.
      const managers = await (prisma as any).departmentMember.findMany({
        where: { tenantId, departmentRole: "MANAGER" },
        include: {
          user: {
            select: { id: true, tenantId: true, email: true, name: true, notificationSoundEnabled: true, isActive: true },
          },
        },
      });
      for (const m of managers) {
        if (m.user?.isActive) out.set(m.user.id, m.user);
      }
    } else {
      const managers = await (prisma as any).departmentMember.findMany({
        where: { tenantId, departmentId, departmentRole: "MANAGER" },
        include: {
          user: {
            select: { id: true, tenantId: true, email: true, name: true, notificationSoundEnabled: true, isActive: true },
          },
        },
      });
      for (const m of managers) {
        if (m.user?.isActive) out.set(m.user.id, m.user);
      }
    }
  } else if (spec.type === "users") {
    if (!Array.isArray(spec.userIds) || spec.userIds.length === 0) return [];
    // Tenant-scoped lookup: even if an attacker wrote a foreign userId into
    // the preference row, the tenant filter excludes it from delivery.
    const users = await (prisma as any).user.findMany({
      where: { tenantId, id: { in: spec.userIds }, isActive: true },
      select: { id: true, tenantId: true, email: true, name: true, notificationSoundEnabled: true },
    });
    for (const u of users) out.set(u.id, u);
  }

  return [...out.values()];
}
