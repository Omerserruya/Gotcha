/**
 * Customer-facing subscription routes. View is open to authenticated tenant
 * members; mutations require the owner-gated `settings:billing:manage`.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission } from "@chatcenter/shared";
import { getSubscriptionForTenant } from "../services/billable-entity.service";
import { changePlan, changeVolume, cancelSubscription, resumeSubscription, previewPlanChange } from "../services/subscription.service";
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

/** The same body for the preview and the change: keys only, never prices. */
function changeInput(req: any) {
  const { planKey, chatVolumeOptionKey, voiceVolumeOptionKey, expectedChargeAmount, expectedFxRateVersion } = req.body ?? {};
  return {
    tenantId: req.tenantId!,
    targetPlanKey: planKey,
    // Volume selectors are passed through as KEYS. `undefined` means "leave the
    // current selection alone"; an explicit null means "clear it".
    chatVolumeOptionKey: chatVolumeOptionKey === undefined ? undefined : chatVolumeOptionKey,
    voiceVolumeOptionKey: voiceVolumeOptionKey === undefined ? undefined : voiceVolumeOptionKey,
    actor: req.user?.userId,
    ...(expectedChargeAmount !== undefined && expectedChargeAmount !== null ? { expectedChargeAmount: String(expectedChargeAmount) } : {}),
    ...(Number.isInteger(expectedFxRateVersion) ? { expectedFxRateVersion } : {}),
  };
}

/**
 * What change-plan would do and charge, exactly, with no side effect: the
 * confirm shows this figure and sends it back as expectedChargeAmount.
 */
router.post("/billing/subscription/change-plan/preview", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  if (!req.body?.planKey) return res.status(400).json({ error: "planKey required" });
  try {
    return res.json({ ok: true, preview: await previewPlanChange(changeInput(req)) });
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? "preview_failed" });
  }
});

router.post("/billing/subscription/change-plan", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  if (!req.body?.planKey) return res.status(400).json({ error: "planKey required" });
  try {
    const result = await changePlan(changeInput(req));
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    // The charge moved since the confirm: nothing was charged; the screen
    // shows the new figure and asks again.
    if (err?.message === "charge_amount_changed" || err?.message === "upgrade_payment_failed:charge_amount_changed") {
      const preview = await previewPlanChange(changeInput(req)).catch(() => null);
      return res.status(409).json({ error: "charge_amount_changed", preview });
    }
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
