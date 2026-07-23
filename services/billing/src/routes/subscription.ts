/**
 * Customer-facing subscription routes. View is open to authenticated tenant
 * members; mutations require the owner-gated `settings:billing:manage`.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission } from "@chatcenter/shared";
import { getSubscriptionForTenant } from "../services/billable-entity.service";
import { changePlan, cancelSubscription, resumeSubscription } from "../services/subscription.service";
import { listActivePlans } from "../services/plan.service";
import { migrateFromGrandfathered } from "../services/grandfather.service";

const router = Router();

router.get("/billing/plans", authenticate, async (_req, res) => {
  res.json({ plans: await listActivePlans() });
});

router.get("/billing/subscription", authenticate, resolveTenant, async (req, res) => {
  const sub = await getSubscriptionForTenant(req.tenantId!);
  res.json({ subscription: sub });
});

router.post("/billing/subscription/change-plan", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { planKey } = req.body ?? {};
  if (!planKey) return res.status(400).json({ error: "planKey required" });
  try {
    const result = await changePlan({ tenantId: req.tenantId!, targetPlanKey: planKey, actor: req.user?.userId });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "change_plan_failed" });
  }
});

router.post("/billing/subscription/cancel", authenticate, resolveTenant, requirePermission("settings:billing:cancel"), async (req, res) => {
  try {
    await cancelSubscription({ tenantId: req.tenantId!, actor: req.user?.userId });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "cancel_failed" });
  }
});

router.post("/billing/subscription/resume", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  try {
    await resumeSubscription({ tenantId: req.tenantId!, actor: req.user?.userId });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "resume_failed" });
  }
});

router.post("/billing/subscription/migrate", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { planKey } = req.body ?? {};
  if (!planKey) return res.status(400).json({ error: "planKey required" });
  try {
    await migrateFromGrandfathered({ tenantId: req.tenantId!, planKey, actor: req.user?.userId });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "migrate_failed" });
  }
});

export default router;
