/**
 * GDPR data-subject-rights endpoints for USERS and TENANTS.
 *
 * Access/portability (Art. 15/20) and erasure (Art. 17) for user and tenant
 * subjects, plus consent (Art. 7) and retention-policy (Art. 5(1)(e))
 * management. Contact/end-customer DSRs live in the conversation service.
 *
 * Authorization:
 *   - user-level export/erasure: tenant ADMIN, scoped to their own tenant.
 *   - tenant-level export/erasure: SYSTEM_ADMIN only.
 */

import { Router, Request, Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  requireSystemAdmin,
  writeAudit,
  AuditAction,
} from "@chatcenter/shared";
import { exportUser, eraseUser, exportTenant, eraseTenant } from "../services/gdpr.service";

const router = Router();

// ─── User-level DSRs (tenant ADMIN) ────────────────────────────

router.get(
  "/users/:userId/export",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await exportUser(req.tenantId!, req.params.userId as string, (req as any).user?.userId);
      if (!data) { res.status(404).json({ error: "user_not_found" }); return; }
      res.setHeader("Content-Disposition", `attachment; filename="user-${req.params.userId}-export.json"`);
      res.json(data);
    } catch (err: any) {
      console.error("[gdpr] user export error:", err?.message);
      res.status(500).json({ error: "export_failed" });
    }
  },
);

router.delete(
  "/users/:userId",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const currentUserId = (req as any).user?.userId as string | undefined;
      if (currentUserId && currentUserId === req.params.userId) {
        res.status(400).json({ error: "cannot_erase_self" });
        return;
      }
      const out = await eraseUser(req.tenantId!, req.params.userId as string, currentUserId);
      if (!out) { res.status(404).json({ error: "user_not_found" }); return; }
      res.json({ data: out });
    } catch (err: any) {
      if (err?.message === "cannot_erase_system_admin") {
        res.status(400).json({ error: "cannot_erase_system_admin" });
        return;
      }
      console.error("[gdpr] user erasure error:", err?.message);
      res.status(500).json({ error: "erasure_failed" });
    }
  },
);

// ─── Tenant-level DSRs (SYSTEM_ADMIN) ──────────────────────────

router.get(
  "/tenants/:tenantId/export",
  authenticate, requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await exportTenant(req.params.tenantId as string, (req as any).user?.userId);
      if (!data) { res.status(404).json({ error: "tenant_not_found" }); return; }
      res.setHeader("Content-Disposition", `attachment; filename="tenant-${req.params.tenantId}-export.json"`);
      res.json(data);
    } catch (err: any) {
      console.error("[gdpr] tenant export error:", err?.message);
      res.status(500).json({ error: "export_failed" });
    }
  },
);

router.delete(
  "/tenants/:tenantId",
  authenticate, requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await eraseTenant(req.params.tenantId as string, (req as any).user?.userId);
      if (!out) { res.status(404).json({ error: "tenant_not_found" }); return; }
      res.json({ data: out });
    } catch (err: any) {
      console.error("[gdpr] tenant erasure error:", err?.message);
      res.status(500).json({ error: "erasure_failed" });
    }
  },
);

// ─── Consent (Art. 7) ──────────────────────────────────────────

router.post(
  "/consent",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { subjectType, subjectId, purpose, granted, source, evidence } = req.body ?? {};
      if (!subjectType || !subjectId || !purpose || typeof granted !== "boolean") {
        res.status(400).json({ error: "subjectType, subjectId, purpose and boolean granted are required" });
        return;
      }
      const record = await prisma.consentRecord.create({
        data: {
          tenantId: req.tenantId!,
          subjectType: String(subjectType),
          subjectId: String(subjectId),
          purpose: String(purpose),
          granted,
          source: source ? String(source) : null,
          evidence: (evidence && typeof evidence === "object" ? evidence : undefined) as any,
        },
      });
      await writeAudit({
        tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
        action: granted ? AuditAction.CONSENT_GRANTED : AuditAction.CONSENT_WITHDRAWN,
        targetType: String(subjectType), targetId: String(subjectId), metadata: { purpose },
      });
      res.status(201).json({ data: record });
    } catch (err: any) {
      console.error("[gdpr] consent record error:", err?.message);
      res.status(500).json({ error: "consent_failed" });
    }
  },
);

router.get(
  "/consent",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { subjectType, subjectId, purpose } = req.query;
      const records = await prisma.consentRecord.findMany({
        where: {
          tenantId: req.tenantId!,
          ...(subjectType ? { subjectType: String(subjectType) } : {}),
          ...(subjectId ? { subjectId: String(subjectId) } : {}),
          ...(purpose ? { purpose: String(purpose) } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      res.json({ data: records });
    } catch (err: any) {
      console.error("[gdpr] consent list error:", err?.message);
      res.status(500).json({ error: "consent_list_failed" });
    }
  },
);

// ─── Retention policies (Art. 5(1)(e)) ─────────────────────────
//
// SYSTEM_ADMIN, not ADMIN - the only routes in this file gated that way while
// still resolving a tenant, and deliberately so. Retention decides when a
// tenant's audit trail, messages and billing events are DELETED. It is the one
// setting whose misuse cannot be investigated afterwards: the rows are gone,
// and a short enough `audit_logs` policy erases the record of the change that
// set it. A tenant admin may read the audit log; only the platform decides how
// long it continues to exist.
//
// `requireSystemAdmin()` is a FACTORY and must be CALLED. Passed uncalled,
// Express receives the factory, which returns a middleware rather than calling
// next(), and the gate silently never runs - the route stays open while
// appearing guarded. `middleware-factories-called.test.ts` exists because that
// has happened in this codebase before.
//
// `resolveTenant` is kept, so a SYSTEM_ADMIN configures retention FOR a tenant
// they can resolve rather than globally. That bounds them to tenants they are a
// member of.
//
// THAT LIMIT WAS RAISED AND THE ANSWER IS TO WIDEN IT. Omer ruled that a system
// admin should reach every tenant, and the tenant administration screen this
// serves already exists - frontend/src/app/system/tenants/[id]. It is
// deliberately NOT done here: widening tenant scoping is its own change, and
// doing it inside a commit about retention would move an access boundary in a
// diff where no reviewer would be looking for one.
//
// So this records a DECISION, not a doubt. The next person should implement the
// widening rather than re-open the question - the pattern is
// `crossTenantMiddleware` beside `requireSystemAdmin()`, as the other
// platform-operator routes use.

/**
 * The six categories the engine can purge. MUST match DEFAULTABLE_CATEGORIES in
 * services/ai/src/services/retention-purge.service.ts - a category in one and
 * not the other is inert, because either the API refuses to configure it or the
 * engine cannot purge it. `retention-categories.test.ts` asserts they agree.
 */
const RETENTION_CATEGORIES = [
  "messages",
  "usage_logs",
  "audit_logs",
  "billing_webhook_events",
  "reasoner_shadow_evals",
  "agent_loop_runs",
] as const;

/**
 * The platform default for a category, read the same way the engine reads it.
 *
 * DUPLICATED FROM THE ENGINE ON PURPOSE, and the duplication is the risk worth
 * naming: the engine lives in services/ai and this API lives in services/auth,
 * so they are two processes reading two copies of the same environment. Set the
 * variable on `ai` and not on `auth` and the engine deletes while this endpoint
 * reports nothing configured - which is precisely the defect below, reintroduced
 * through configuration instead of code. Whoever plumbs these must plumb BOTH.
 */
function envDefaultDays(category: string): number | null {
  const raw = process.env[`RETENTION_DEFAULT_${category.toUpperCase()}_DAYS`];
  if (!raw) return null;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : null;
}

/**
 * GET /retention - the EFFECTIVE policy, not the stored rows.
 *
 * It used to return `dataRetentionPolicy.findMany()` and nothing else, while the
 * engine purges on two sources: a tenant's stored row when it is ENABLED, and a
 * platform default from the environment for every tenant without one. So a
 * category being deleted on the platform's schedule came back as absent, and a
 * system admin opening this screen to find out what the retention is would read
 * "nothing configured" while data disappeared daily.
 *
 * THE CASE THAT IS WORSE THAN AN ABSENT ROW: `runRetentionPurge` selects
 * policies `where: { enabled: true }` and builds its "already covered" set from
 * THAT list. A tenant who creates a policy and then DISABLES it is therefore not
 * covered, and the platform default applies to them. Disabled does not mean "no
 * deletion" - it means "fall back to the platform's number". Someone who turned
 * retention off to stop data being deleted would have been shown their own
 * `enabled: false` row as confirmation while the engine deleted anyway. That row
 * is still returned, under `configured`, so the disable is visible - but
 * `source` and `retentionDays` report what is actually in force.
 *
 * Every category is returned, including ones with no policy and no default, so
 * the answer to "what happens to my messages" is never an absence the reader has
 * to interpret.
 */
router.get(
  "/retention",
  authenticate, resolveTenant, requireActiveTenant(), requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const policies = await prisma.dataRetentionPolicy.findMany({
        where: { tenantId: req.tenantId! },
        orderBy: { category: "asc" },
      });
      const byCategory = new Map(policies.map((p) => [p.category, p]));

      const data = RETENTION_CATEGORIES.map((category) => {
        const row = byCategory.get(category) ?? null;
        const fallbackDays = envDefaultDays(category);

        // Mirrors the engine's own precedence: an ENABLED row wins; otherwise
        // the platform default applies whether or not a disabled row exists.
        const tenantWins = row != null && row.enabled;
        const source = tenantWins ? "tenant" : fallbackDays != null ? "platform_default" : "none";
        const retentionDays = tenantWins ? row!.retentionDays : fallbackDays;

        return {
          category,
          // What is actually in force. Null means nothing is deleted.
          retentionDays,
          source,
          // True when rows in this category are being deleted on a schedule,
          // by either source. The one field a reader needs to answer "is my
          // data being removed".
          purging: retentionDays != null,
          // The tenant's own row, when they have one, so a disable stays
          // visible even when it is not in effect.
          configured: row
            ? { retentionDays: row.retentionDays, enabled: row.enabled, lastPurgeAt: row.lastPurgeAt, updatedAt: row.updatedAt }
            : null,
          // Set when a stored row exists but the platform default is what runs.
          // The reader has taken an action that is not having the effect they
          // expect, and that deserves to be stated rather than inferred.
          overriddenByPlatformDefault: row != null && !row.enabled && fallbackDays != null,
        };
      });

      res.json({ data });
    } catch (err: any) {
      console.error("[gdpr] retention list error:", err?.message);
      res.status(500).json({ error: "retention_list_failed" });
    }
  },
);

router.put(
  "/retention",
  authenticate, resolveTenant, requireActiveTenant(), requireSystemAdmin(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { category, retentionDays, enabled } = req.body ?? {};
      // One list, defined at the top of this file, so the categories this
      // route accepts and the categories GET reports cannot drift apart.
      const allowed = new Set<string>(RETENTION_CATEGORIES);
      if (!category || !allowed.has(String(category))) {
        res.status(400).json({ error: `category must be one of: ${[...allowed].join(", ")}` });
        return;
      }
      if (typeof retentionDays !== "number" || retentionDays < 1) {
        res.status(400).json({ error: "retentionDays must be a positive number" });
        return;
      }
      const policy = await prisma.dataRetentionPolicy.upsert({
        where: { tenantId_category: { tenantId: req.tenantId!, category: String(category) } },
        create: {
          tenantId: req.tenantId!, category: String(category),
          retentionDays: Math.floor(retentionDays), enabled: enabled !== false,
        },
        update: {
          retentionDays: Math.floor(retentionDays),
          ...(typeof enabled === "boolean" ? { enabled } : {}),
        },
      });
      await writeAudit({
        tenantId: req.tenantId!, actorType: "user", actorId: (req as any).user?.userId,
        action: "retention.policy_changed", targetType: "retention_policy", targetId: policy.id,
        metadata: { category, retentionDays },
      });
      res.json({ data: policy });
    } catch (err: any) {
      console.error("[gdpr] retention upsert error:", err?.message);
      res.status(500).json({ error: "retention_upsert_failed" });
    }
  },
);

export default router;
