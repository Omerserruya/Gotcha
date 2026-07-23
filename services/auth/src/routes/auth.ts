import { Router, Request, Response } from "express";
import { authenticate, prisma, withCrossTenantAccess, writeAudit, AuditAction } from "@chatcenter/shared";

/**
 * Session routes.
 *
 * Everything that used to live here - register, login, magic-link, refresh,
 * change-password, forgot-password, reset-password - is now Authentik's job.
 * GOTCHA cannot issue, refresh, or reset a credential, by construction: it has
 * no signing key and stores no password.
 *
 * What remains is business identity: given a person Authentik has already
 * proven, tell the caller who they are *in GOTCHA* - their MEMBERSHIPS (one
 * per tenant, each with its own role/department), which one is active, and
 * the switch between them. That is business data, and it stays here.
 */
const router = Router();

/** The caller's memberships, newest-activity first, with tenant context.
 *  Deliberately CROSS-tenant: the rows are the authenticated person's OWN
 *  membership rows, keyed by their identityId (from the verified principal,
 *  never from client input) - which is exactly the query the TenantGuard
 *  cannot express. */
async function listMemberships(identityId: string) {
  const rows = await withCrossTenantAccess(() => prisma.user.findMany({
    where: { identityId, isActive: true },
    select: {
      id: true,
      role: true,
      lastActiveAt: true,
      createdAt: true,
      tenant: { select: { id: true, name: true, slug: true, status: true, isActive: true } },
    },
    orderBy: [{ lastActiveAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
  }));
  return rows.map((m) => ({
    userId: m.id,
    role: m.role,
    lastActiveAt: m.lastActiveAt,
    memberSince: m.createdAt,
    tenant: {
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
      status: m.tenant.status,
      isActive: m.tenant.isActive,
    },
  }));
}

router.get("/me", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        identityId: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const member = await prisma.departmentMember.findFirst({
      // tenantId is REQUIRED: DepartmentMember is tenant-guarded and findFirst
      // is a bulk op, so it throws without it (unlike the old findUnique).
      where: { userId: user.id, tenantId: user.tenantId },
      orderBy: { createdAt: "asc" },
      include: { department: { select: { id: true, name: true } } },
    });
    const deptInfo = member
      ? {
          departmentId: member.departmentId,
          departmentRole: member.departmentRole,
          departmentName: member.department.name,
        }
      : {};

    const [tenant, memberships] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { status: true, name: true },
      }),
      listMemberships(user.identityId),
    ]);

    res.json({
      user: { ...user, ...deptInfo },
      tenantStatus: tenant?.status || "ACTIVE",
      tenantName: tenant?.name ?? null,
      // Every tenant this person can enter. length > 1 → the client shows the
      // tenant switcher / picker.
      memberships,
    });
  } catch (err) {
    // Never swallow silently - this 500 was invisible in the logs. Surface the
    // real cause (stack) so auth failures are diagnosable.
    console.error("[/api/auth/me] failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * The caller's memberships, standalone - used by the post-login tenant picker
 * BEFORE an active tenant is chosen. authenticate() resolves a default
 * membership even without an X-Tenant-Id header, so this endpoint is reachable
 * exactly when the picker needs it.
 */
router.get("/me/memberships", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { identityId: true, identity: { select: { lastTenantId: true } } },
    });
    if (!me) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const memberships = await listMemberships(me.identityId);
    res.json({
      memberships,
      lastTenantId: me.identity.lastTenantId,
      activeTenantId: req.tenantId ?? null,
    });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Switch the ACTIVE tenant. Validates the target against the caller's
 * memberships (never trusts the id), stamps last-used so future hint-less
 * requests and the picker default follow the person, and returns the target
 * membership. The client then re-issues requests with X-Tenant-Id set - no
 * re-login: the Authentik session/token identifies the PERSON, not the tenant.
 */
router.post("/me/switch-tenant", authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = (req.body?.tenantId ?? "").toString();
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required" });
      return;
    }
    const me = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { identityId: true },
    });
    if (!me) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const membership = await prisma.user.findUnique({
      where: { tenantId_identityId: { tenantId, identityId: me.identityId } },
      select: {
        id: true, role: true, isActive: true,
        tenant: { select: { id: true, name: true, slug: true, status: true, isActive: true } },
      },
    });
    if (!membership || !membership.isActive) {
      res.status(403).json({ error: "No membership in the requested tenant", code: "tenant_denied" });
      return;
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({ where: { id: membership.id }, data: { lastActiveAt: now } }),
      prisma.identity.update({ where: { id: me.identityId }, data: { lastTenantId: tenantId } }),
    ]);

    void writeAudit({
      tenantId, actorType: "user", actorId: membership.id,
      action: AuditAction.TENANT_SWITCHED, targetType: "user", targetId: membership.id,
      metadata: { fromTenantId: req.tenantId ?? null },
    });

    res.json({
      userId: membership.id,
      role: membership.role,
      tenant: membership.tenant,
    });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
