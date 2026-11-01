/**
 * Support mode: a GOTCHA admin enters a tenant and works in it as its admin
 * (Omer, 2026-11-01). These routes start, show and end the session; the
 * session itself is honoured in shared authenticate() (support-principal.ts),
 * and what it may not do is support-deny.ts.
 *
 *   POST /api/system/support-sessions          { tenantId, reason }  -> 201
 *   GET  /api/system/support-sessions/current                         -> { data }
 *   POST /api/system/support-sessions/:id/end                         -> 200
 *
 * Called with the admin's OWN session (no x-support-session header): a
 * support principal is the tenant's ADMIN, never SYSTEM_ADMIN, so
 * requireSystemAdmin refuses it.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, requireSystemAdmin, validate, writeAudit, withCrossTenantAccess } from "@chatcenter/shared";

const router = Router();

/** Two hours (Omer's brief). */
export const SUPPORT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** The one non-login identity every tenant's support actor hangs off. */
export const SUPPORT_IDENTITY_EMAIL = "support@gotcha.internal";
export const SUPPORT_ACTOR_NAME = "GOTCHA Support";

const startSchema = z.object({
  tenantId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
}).strict();

/** The tenant's hidden support user, created on first use. */
export async function ensureSupportActor(tenantId: string): Promise<{ id: string }> {
  return withCrossTenantAccess(async () => {
    const identity =
      (await prisma.identity.findUnique({ where: { email: SUPPORT_IDENTITY_EMAIL }, select: { id: true } })) ??
      // No Authentik subject: this identity can never sign in.
      (await prisma.identity.create({ data: { email: SUPPORT_IDENTITY_EMAIL, authentikSubject: null } as any, select: { id: true } }));
    const existing = await prisma.user.findFirst({ where: { tenantId, kind: "support" } as any, select: { id: true } });
    if (existing) return existing;
    return prisma.user.create({
      data: { tenantId, identityId: identity.id, email: SUPPORT_IDENTITY_EMAIL, name: SUPPORT_ACTOR_NAME, role: "ADMIN" as any, isActive: true, kind: "support" } as any,
      select: { id: true },
    });
  });
}

const view = (s: any, tenantName: string | null) => ({
  id: s.id,
  tenantId: s.tenantId,
  tenantName,
  reason: s.reason,
  startedAt: s.startedAt,
  expiresAt: s.expiresAt,
  actor: { userId: s.supportUserId, displayName: SUPPORT_ACTOR_NAME },
});

router.post("/support-sessions", authenticate, requireSystemAdmin(), validate(startSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const admin = (req as any).user;
    if (!admin?.sessionId || !admin?.identityId) {
      res.status(400).json({ error: "Support mode needs a signed-in console session", code: "support_requires_session" });
      return;
    }
    const { tenantId, reason } = req.body as { tenantId: string; reason: string };
    const tenant = await withCrossTenantAccess(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } }));
    if (!tenant) { res.status(404).json({ error: "Workspace not found", code: "tenant_not_found" }); return; }
    if (tenant.slug === "system" || tenant.id === admin.tenantId) {
      res.status(409).json({ error: "Support mode is for a customer workspace", code: "support_system_tenant" });
      return;
    }
    const now = new Date();
    const live = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.findFirst({
      where: { userSessionId: admin.sessionId, endedAt: null, expiresAt: { gt: now } },
    }));
    if (live) {
      res.status(409).json({ error: "This login already has a support session", code: "support_session_active", data: { id: live.id, tenantId: live.tenantId } });
      return;
    }
    const actor = await ensureSupportActor(tenantId);
    const s = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.create({
      data: {
        tenantId, adminIdentityId: admin.identityId, adminUserId: admin.userId, userSessionId: admin.sessionId,
        supportUserId: actor.id, reason, expiresAt: new Date(now.getTime() + SUPPORT_SESSION_TTL_MS),
      },
    }));
    const meta = { supportSessionId: s.id, adminUserId: admin.userId, adminEmail: admin.email, reason, expiresAt: s.expiresAt };
    // In the supported tenant (the merchant's own history) and in System.
    await writeAudit({ tenantId, actorType: "support", actorId: actor.id, action: "support.session.started", targetType: "support_session", targetId: s.id, metadata: meta });
    await writeAudit({ tenantId: admin.tenantId, actorType: "user", actorId: admin.userId, action: "support.session.started", targetType: "tenant", targetId: tenantId, metadata: meta });
    res.status(201).json({ data: view(s, tenant.name) });
  } catch (err: any) {
    console.error("[support] start failed:", err?.message);
    res.status(500).json({ error: "Could not start support mode" });
  }
});

router.get("/support-sessions/current", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const s = admin?.sessionId
    ? await withCrossTenantAccess<any>(() => (prisma as any).supportSession.findFirst({ where: { userSessionId: admin.sessionId, endedAt: null, expiresAt: { gt: new Date() } } }))
    : null;
  if (!s) { res.json({ data: null }); return; }
  const tenant = await withCrossTenantAccess(() => prisma.tenant.findUnique({ where: { id: s.tenantId }, select: { name: true } }));
  res.json({ data: view(s, tenant?.name ?? null) });
});

/** End one session. Idempotent; also called on logout (endSupportSessionsForLogin). */
export async function endSupportSession(id: string, reason: string): Promise<any | null> {
  const s = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.findUnique({ where: { id } }));
  if (!s) return null;
  if (s.endedAt) return s;
  const ended = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.update({ where: { id }, data: { endedAt: new Date(), endedReason: reason } }));
  await writeAudit({ tenantId: s.tenantId, actorType: "support", actorId: s.supportUserId, action: "support.session.ended", targetType: "support_session", targetId: s.id, metadata: { supportSessionId: s.id, adminUserId: s.adminUserId, endedReason: reason } });
  return ended;
}

export async function endSupportSessionsForLogin(userSessionId: string, reason: string): Promise<number> {
  const live = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.findMany({ where: { userSessionId, endedAt: null }, select: { id: true } }));
  for (const s of live as Array<{ id: string }>) await endSupportSession(s.id, reason);
  return live.length;
}

router.post("/support-sessions/:id/end", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const s = await withCrossTenantAccess<any>(() => (prisma as any).supportSession.findUnique({ where: { id: String(req.params.id) } }));
  if (!s || s.adminUserId !== admin.userId) { res.status(404).json({ error: "Support session not found", code: "support_session_not_found" }); return; }
  const ended = await endSupportSession(s.id, "ended");
  res.json({ data: { id: s.id, endedAt: ended.endedAt } });
});

export default router;
