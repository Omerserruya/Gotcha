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

router.get(
  "/retention",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const policies = await prisma.dataRetentionPolicy.findMany({
        where: { tenantId: req.tenantId! },
        orderBy: { category: "asc" },
      });
      res.json({ data: policies });
    } catch (err: any) {
      console.error("[gdpr] retention list error:", err?.message);
      res.status(500).json({ error: "retention_list_failed" });
    }
  },
);

router.put(
  "/retention",
  authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { category, retentionDays, enabled } = req.body ?? {};
      // Must match DEFAULTABLE_CATEGORIES in retention-purge.service.ts. A
      // category present in one and not the other is inert: either the API
      // refuses to configure it, or the engine cannot purge it.
      // retention-categories.test.ts asserts the two agree.
      const allowed = new Set(["messages", "usage_logs", "audit_logs", "billing_webhook_events", "reasoner_shadow_evals", "agent_loop_runs"]);
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
