/**
 * Support mode: a SYSTEM_ADMIN working inside a tenant as its admin.
 *
 * The browser never carries the support session. The BFF keeps its id and
 * sends `x-support-session` with `x-tenant-id`; this turns the admin's own
 * (System-tenant) principal into the target tenant's ADMIN only when the
 * session is live, belongs to THIS login, and names THIS tenant. Anything
 * else is refused - there is no fallback to the System tenant.
 *
 * The principal's role is ADMIN, never SYSTEM_ADMIN, so no SYSTEM_ADMIN
 * bypass (rbac, feature gates, tenant status) applies: the admin sees what
 * the merchant has. support-deny.ts caps what an ADMIN could otherwise do.
 */
import { prisma } from "./prisma";
import { AuthError } from "./principal";
import type { JwtPayload } from "./jwt";

export const SUPPORT_SESSION_HEADER = "x-support-session";

export async function resolveSupportPrincipal(
  admin: JwtPayload & { sessionId?: string },
  supportSessionId: string,
  targetTenantId: string | null,
  now: Date = new Date(),
): Promise<JwtPayload> {
  if (admin.role !== "SYSTEM_ADMIN" || !admin.sessionId) {
    throw new AuthError("Support mode is for a GOTCHA admin's own session", "support_session_invalid");
  }
  const s = await (prisma as any).supportSession.findUnique({ where: { id: supportSessionId } });
  if (!s || s.userSessionId !== admin.sessionId || s.adminUserId !== admin.userId) {
    throw new AuthError("Not your support session", "support_session_invalid");
  }
  if (s.endedAt || s.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError("The support session has ended", "support_expired");
  }
  if (!targetTenantId || targetTenantId !== s.tenantId) {
    throw new AuthError("The support session is for another workspace", "support_session_invalid");
  }
  const actor = await prisma.user.findFirst({
    where: { id: s.supportUserId, tenantId: s.tenantId, kind: "support" } as any,
    select: { id: true, email: true },
  });
  if (!actor) throw new AuthError("The workspace's support actor is missing", "support_session_invalid");

  return {
    userId: actor.id,
    identityId: admin.identityId,
    tenantId: s.tenantId,
    role: "ADMIN",
    email: actor.email,
    support: {
      sessionId: s.id,
      adminUserId: admin.userId,
      adminEmail: admin.email,
      expiresAt: s.expiresAt.toISOString(),
      startedAt: s.startedAt.toISOString(),
      reason: s.reason,
    },
  } as JwtPayload;
}
