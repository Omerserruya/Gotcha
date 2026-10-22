/**
 * The viewer's commerce permissions, resolved once per request.
 *
 * Shared by the conversation commerce panel and the customer order history so
 * the two cannot compute a viewer's rights differently (capabilities and
 * per-order eligibility are derived from these).
 */
import type { Request } from "express";
import { hasPermission, type PermissionPrincipal } from "@chatcenter/shared";

export function principalOf(req: Request & { tenantId?: string }): PermissionPrincipal {
  const u = (req as any).user ?? {};
  return {
    userId: u.userId,
    tenantId: req.tenantId || u.tenantId,
    role: u.role,
    departmentRole: u.departmentRole,
  };
}

export async function commercePerms(p: PermissionPrincipal) {
  const [canRead, canOpen, canCancel, canRefund, canReturn, canTag, canNote, canNotify] = await Promise.all([
    hasPermission(p, "customer:commerce:read"),
    hasPermission(p, "customer:commerce:open"),
    hasPermission(p, "customer:commerce:cancel"),
    hasPermission(p, "customer:commerce:refund"),
    hasPermission(p, "customer:commerce:return"),
    hasPermission(p, "customer:commerce:tag"),
    hasPermission(p, "customer:commerce:note"),
    hasPermission(p, "customer:commerce:notify"),
  ]);
  return { canRead, canOpen, canCancel, canRefund, canReturn, canTag, canNote, canNotify };
}

/**
 * May the caller see every customer, as on the customers screen
 * (crm:contacts:read, or the ADMIN role that the screen's gate also accepts)?
 */
export async function canReadContacts(req: Request & { tenantId?: string }): Promise<boolean> {
  const p = principalOf(req);
  if (p.role === "ADMIN") return true;
  return hasPermission(p, "crm:contacts:read").catch(() => false);
}

/** May the caller read the knowledge screen (ai:knowledge:read, or ADMIN)? */
export async function canReadKnowledge(req: Request & { tenantId?: string }): Promise<boolean> {
  const p = principalOf(req);
  if (p.role === "ADMIN") return true;
  return hasPermission(p, "ai:knowledge:read").catch(() => false);
}
