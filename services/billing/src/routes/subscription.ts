/**
 * Customer-facing subscription routes. View is open to authenticated tenant
 * members; mutations require the owner-gated `settings:billing:manage`.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission } from "@chatcenter/shared";
import { getSubscriptionForTenant } from "../services/billable-entity.service";
import { changePlan, changeVolume, cancelSubscription, resumeSubscription } from "../services/subscription.service";
import { listActivePlans } from "../services/plan.service";
import { migrateFromGrandfathered } from "../services/grandfather.service";

const router = Router();

// Tenant-scoped so an organization sees its OWN custom plan alongside the
// public catalog - and never another organization's negotiated terms.
router.get("/billing/plans", authenticate, resolveTenant, async (req, res) => {
  res.json({ plans: await listActivePlans(req.tenantId ?? null) });
});

router.get("/billing/subscription", authenticate, resolveTenant, async (req, res) => {
  const sub = await getSubscriptionForTenant(req.tenantId!);
  res.json({ subscription: sub });
});

router.post("/billing/subscription/change-plan", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { planKey, chatVolumeOptionKey, voiceVolumeOptionKey } = req.body ?? {};
  if (!planKey) return res.status(400).json({ error: "planKey required" });
  try {
    // Volume selectors are passed through as KEYS. `undefined` means "leave the
    // current selection alone"; an explicit null means "clear it".
    const result = await changePlan({
      tenantId: req.tenantId!,
      targetPlanKey: planKey,
      chatVolumeOptionKey: chatVolumeOptionKey === undefined ? undefined : chatVolumeOptionKey,
      voiceVolumeOptionKey: voiceVolumeOptionKey === undefined ? undefined : voiceVolumeOptionKey,
      actor: req.user?.userId,
    });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "change_plan_failed" });
  }
});

/** Change only the chat/voice volume selection, staying on the same plan. */
router.post("/billing/subscription/change-volume", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { chatVolumeOptionKey, voiceVolumeOptionKey } = req.body ?? {};
  try {
    const result = await changeVolume({
      tenantId: req.tenantId!,
      chatVolumeOptionKey: chatVolumeOptionKey === undefined ? undefined : chatVolumeOptionKey,
      voiceVolumeOptionKey: voiceVolumeOptionKey === undefined ? undefined : voiceVolumeOptionKey,
      actor: req.user?.userId,
    });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "change_volume_failed" });
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
