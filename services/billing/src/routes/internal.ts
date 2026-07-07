/**
 * Internal service-to-service endpoints (X-Internal-Key). Called by auth
 * (signup → start trial), by the AI runtime gate (trigger auto-purchase when
 * Units run low), and by ops (grandfather backfill, run billing cycle).
 */
import { Router } from "express";
import { requireInternalKey } from "../lib/internal-auth";
import { ensureBillableEntity } from "../services/billable-entity.service";
import { createTrialSubscription } from "../services/subscription.service";
import { triggerAutoPurchase } from "../services/purchase.service";
import { backfillAllTenants, grandfatherTenant } from "../services/grandfather.service";
import { runBillingCycle } from "../services/subscription.service";
import { runDunning } from "../services/dunning.service";
import { refundCharge } from "../services/refund.service";
import { emitBillingEvent } from "../lib/events";

const router = Router();
router.use("/internal/billing", requireInternalKey);

router.post("/internal/billing/ensure-entity", async (req, res) => {
  const { tenantId } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const entityId = await ensureBillableEntity(tenantId);
  res.json({ entityId });
});

/** Signup completes here: card already tokenized → start the 14-day trial. */
router.post("/internal/billing/start-trial", async (req, res) => {
  const { tenantId, planKey, billingProfileId } = req.body ?? {};
  if (!tenantId || !planKey) return res.status(400).json({ error: "tenantId and planKey required" });
  try {
    const sub = await createTrialSubscription({ tenantId, planKey, billingProfileId });
    res.json({ ok: true, subscriptionId: sub.id });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "start_trial_failed" });
  }
});

/** Called by the AI runtime gate when balance crosses the auto-purchase threshold. */
router.post("/internal/billing/auto-purchase", async (req, res) => {
  const { tenantId, reason } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const result = await triggerAutoPurchase({ tenantId, reason });
  res.json(result);
});

/**
 * Called by the AI runtime when Unit consumption crosses 80/90/95/100%.
 * Emits owner alerts and attempts auto-purchase (which self-gates on policy +
 * monthly ceiling). The AI gate already blocked the turn if balance hit zero.
 */
router.post("/internal/billing/usage-threshold", async (req, res) => {
  const { tenantId, thresholds } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  for (const t of (thresholds ?? []) as number[]) {
    if (t >= 100) await emitBillingEvent({ type: "credit.exhausted", tenantId, data: { pct: 100 } });
    else await emitBillingEvent({ type: "credit.threshold", tenantId, data: { pct: t } });
  }
  const autoPurchase = await triggerAutoPurchase({ tenantId, reason: "usage_threshold" });
  res.json({ ok: true, autoPurchase });
});

router.post("/internal/billing/grandfather", async (req, res) => {
  const { tenantId } = req.body ?? {};
  if (tenantId) {
    await grandfatherTenant(tenantId);
    return res.json({ ok: true, tenantId });
  }
  const result = await backfillAllTenants();
  res.json({ ok: true, ...result });
});

/** Ops-initiated refund of a successful charge (claws back purchased Units). */
router.post("/internal/billing/refund", async (req, res) => {
  const { chargeId, amount, reason } = req.body ?? {};
  if (!chargeId) return res.status(400).json({ error: "chargeId required" });
  const result = await refundCharge({ chargeId, amount, reason });
  res.status(result.ok ? 200 : 400).json(result);
});

/** Ops/scheduler hook — process trials, renewals, pending changes, dunning. */
router.post("/internal/billing/run-cycle", async (_req, res) => {
  const cycle = await runBillingCycle();
  const dunning = await runDunning();
  res.json({ ok: true, cycle, dunning });
});

export default router;
