/**
 * Internal service-to-service endpoints (X-Internal-Key). Called by auth
 * (signup → start trial), by the AI runtime gate (trigger auto-purchase when
 * Units run low), and by ops (grandfather backfill, run billing cycle).
 */
import { Router } from "express";
import { prisma, grantUnits, getBalance } from "@chatcenter/shared";
import { requireInternalKey } from "../lib/internal-auth";
import { ensureBillableEntity, getEntityIdForTenant } from "../services/billable-entity.service";
import { createTrialSubscription } from "../services/subscription.service";
import { triggerAutoPurchase } from "../services/purchase.service";
import { backfillAllTenants, grandfatherTenant } from "../services/grandfather.service";
import { runBillingCycle } from "../services/subscription.service";
import { runDunning } from "../services/dunning.service";
import { refundCharge } from "../services/refund.service";
import { setupPoc } from "../services/poc.service";
import {
  provisionPaidTenant,
  resolveAndValidatePlan,
  ProvisioningRefused,
} from "../services/paid-provisioning.service";
import { issueContinuationLink, revokeLinksForCheckout } from "../services/continuation-link.service";
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

/** Ops/scheduler hook - process trials, renewals, pending changes, dunning. */
router.post("/internal/billing/run-cycle", async (_req, res) => {
  const cycle = await runBillingCycle();
  const dunning = await runDunning();
  res.json({ ok: true, cycle, dunning });
});

/**
 * SYSTEM_ADMIN console: provision a card-less POC - a real, ENFORCED
 * subscription with an operator-set credit budget and optional expiry.
 */
router.post("/internal/billing/setup-poc", async (req, res) => {
  const { tenantId, credits, expiresAt, actor } = req.body ?? {};
  if (!tenantId || typeof credits !== "number" || credits <= 0) {
    return res.status(400).json({ error: "tenantId and positive credits required" });
  }
  try {
    const result = await setupPoc({ tenantId, credits, expiresAt: expiresAt ? new Date(expiresAt) : null, actor });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "setup_poc_failed" });
  }
});

/** SYSTEM_ADMIN console: top up credits (PURCHASED bucket - never expires). */
router.post("/internal/billing/grant-credits", async (req, res) => {
  const { tenantId, units, actor } = req.body ?? {};
  if (!tenantId || typeof units !== "number" || units <= 0) {
    return res.status(400).json({ error: "tenantId and positive units required" });
  }
  await grantUnits({ tenantId, bucket: "PURCHASED", grantType: "PROMO", units, source: `admin:${actor ?? "system"}` });
  res.json({ ok: true, balance: await getBalance(tenantId) });
});

/** SYSTEM_ADMIN console: subscription + wallet snapshot for one tenant. */
router.get("/internal/billing/summary", async (req, res) => {
  const tenantId = String(req.query.tenantId || "");
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const entityId = await getEntityIdForTenant(tenantId);
  const subscription = entityId
    ? await prisma.subscription.findUnique({
        where: { billableEntityId: entityId },
        select: { planKey: true, status: true, enforcementEnabled: true, currentPeriodEnd: true, trialEndsAt: true },
      })
    : null;
  res.json({ ok: true, subscription, balance: await getBalance(tenantId) });
});

export default router;


// ── Paid-tenant provisioning (called by auth's Sysadmin tenant-creation) ─────

/**
 * Validate a plan + volume selection WITHOUT creating anything.
 *
 * Called before the tenant is created, so a bad selection fails while there is
 * still nothing to roll back. It also returns the server-computed commercial
 * summary, which is the only figure the Sysadmin UI is allowed to display.
 */
router.post("/internal/billing/validate-paid-plan", async (req, res) => {
  const { planVersionId, chatVolumeOptionKey, voiceVolumeOptionKey, billingInterval } = req.body ?? {};
  if (!planVersionId) return res.status(400).json({ error: "planVersionId required" });
  try {
    const plan = await resolveAndValidatePlan({
      planVersionId,
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
      billingInterval,
    });
    res.json({ ok: true, planKey: plan.key, planVersion: plan.version, planName: plan.name });
  } catch (err: any) {
    const code = err instanceof ProvisioningRefused ? err.code : "validation_failed";
    res.status(400).json({ error: code, message: err?.message });
  }
});

/**
 * Create the billing scaffolding for an already-created paid tenant.
 *
 * Returns the raw continuation token exactly once, for the caller to put in
 * one email. It is never persisted and never returned again.
 */
router.post("/internal/billing/provision-paid-tenant", async (req, res) => {
  const { tenantId, planVersionId, chatVolumeOptionKey, voiceVolumeOptionKey, billingInterval, commercialNote, actor, idempotencyKey } =
    req.body ?? {};
  if (!tenantId || !planVersionId) {
    return res.status(400).json({ error: "tenantId and planVersionId required" });
  }
  try {
    const result = await provisionPaidTenant({
      tenantId,
      planVersionId,
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
      billingInterval,
      commercialNote: commercialNote ?? null,
      actor: actor ?? null,
      idempotencyKey: idempotencyKey ?? undefined,
      rawRequest: req.body ?? {},
    });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const code = err instanceof ProvisioningRefused ? err.code : "provisioning_failed";
    res.status(400).json({ error: code, message: err?.message });
  }
});

/**
 * Issue a replacement continuation link.
 *
 * Reuses the SAME checkout and the SAME payment attempt: a resend is a new
 * envelope for the existing offer, not a new offer. Issuing revokes the prior
 * link inside one transaction, so at most one link is ever valid.
 */
router.post("/internal/billing/resend-payment-link", async (req, res) => {
  const { tenantId, actor } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const checkout = await prisma.pendingCheckout.findFirst({
    where: { tenantId, status: { in: ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!checkout) {
    // Resend reuses; it never creates. A tenant whose provisioning never
    // completed needs REPAIR, and conflating the two would hide a broken
    // provisioning behind a button that looks like it worked.
    return res.status(409).json({ error: "BILLING_PROVISIONING_INCOMPLETE" });
  }
  if (checkout.expiresAt.getTime() <= Date.now()) {
    // Deliberately not auto-reissued: a new expiry would be a new commercial
    // offer, and that is a decision, not a side effect of clicking resend.
    return res.status(409).json({ error: "PAYMENT_LINK_NOT_AVAILABLE", detail: "checkout_expired" });
  }

  // Rate limit, DB-backed so it holds across instances. Resend exists to
  // repair a lost email, not to be a send button.
  const cooldownSec = Number(process.env.PAYMENT_LINK_RESEND_COOLDOWN_SECONDS || 60);
  const recent = await prisma.paymentContinuationLink.findFirst({
    where: { checkoutId: checkout.id },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (recent && Date.now() - recent.createdAt.getTime() < cooldownSec * 1000) {
    const retryAfter = Math.ceil((cooldownSec * 1000 - (Date.now() - recent.createdAt.getTime())) / 1000);
    return res.status(429).json({ error: "PAYMENT_LINK_RATE_LIMITED", retryAfterSeconds: retryAfter });
  }

  const link = await issueContinuationLink({
    checkoutId: checkout.id,
    tenantId,
    createdBy: actor ?? null,
  });

  res.json({
    ok: true,
    checkoutId: checkout.id,
    checkoutReference: checkout.reference,
    link,
    // The snapshot is reused verbatim - a resend never re-prices.
    summary: {
      planKey: checkout.planKey,
      planVersion: checkout.planVersion,
      amount: String(checkout.amount),
      currency: checkout.currency,
      includedCredits: checkout.snapshotIncludedCredits,
      expiresAt: link.expiresAt,
    },
  });
});

/** Revoke every active link for a tenant's checkout, without reissuing. */
router.post("/internal/billing/revoke-payment-links", async (req, res) => {
  const { tenantId } = req.body ?? {};
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const checkout = await prisma.pendingCheckout.findFirst({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
  if (!checkout) return res.status(404).json({ error: "no_checkout" });
  const revoked = await revokeLinksForCheckout(checkout.id);
  res.json({ ok: true, revoked });
});
