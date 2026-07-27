/**
 * AI-Unit balance, credit packages, manual purchase, and the auto-purchase
 * policy. Balance is read-only for any authenticated tenant member; purchases
 * and policy changes are owner-gated.
 */
import { Router } from "express";
import {
  authenticate,
  resolveTenant,
  requirePermission,
  prisma,
  getBalance,
  resolveEstimation,
  ratiosFromSnapshot,
  estimateRemainingConversations,
  ESTIMATE_DISCLAIMER,
} from "@chatcenter/shared";
import { ensureBillableEntity, getEntityIdForTenant, getSubscriptionForTenant } from "../services/billable-entity.service";
import { listActivePlans } from "../services/plan.service";
import { buyCredits } from "../services/purchase.service";
import { periodKeyFor } from "../lib/period";

const router = Router();

/**
 * Canonical customer-facing credit contract - ONE source for every number the
 * Usage/Billing UI shows. Credits (not model tokens) are the unit throughout.
 * Composes: the subscription's included allowance, the real ledger balance
 * (getBalance), and the auto-purchase money-spend window. The two are kept
 * strictly separate: `usage` is plan-CREDIT consumption; `usageCredits` is
 * MONEY spent on automatic top-ups. Read-only for any tenant member.
 */
router.get("/billing/credit-summary", authenticate, resolveTenant, async (req, res) => {
  const tenantId = req.tenantId!;
  const [balance, sub, plans, entityId] = await Promise.all([
    getBalance(tenantId),
    getSubscriptionForTenant(tenantId),
    listActivePlans(),
    getEntityIdForTenant(tenantId),
  ]);
  const plan = plans.find((p) => p.key === (sub as any)?.planKey) ?? null;
  const policy = entityId
    ? await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } })
    : null;

  // Auto-purchase spend is written keyed on the WALL-CLOCK month
  // (triggerAutoPurchase uses periodKeyFor(new Date())); read it back the same
  // way so a rolled-over month shows 0 spent, not a stale carry-over.
  const currentMonthKey = periodKeyFor(new Date());
  const spentAmount =
    policy && policy.monthSpendKey === currentMonthKey ? Number(policy.monthSpentAmount) : 0;

  // The CONTRACTED allowance, from the subscription's own snapshot. Reading the
  // live plan here would restate an existing customer's included credits the
  // moment a new plan version is published.
  const includedCredits =
    (sub as any)?.snapshotIncludedCredits ??
    (plan ? Math.round((plan as any).includedAiUnits ?? 0) : Math.round(balance.includedAllowance));
  const consumedCredits = Math.max(0, balance.includedAllowance - balance.includedRemaining);
  const periodEnd = (sub as any)?.currentPeriodEnd ?? null;

  // Public commercial ratios, snapshotted for this subscription where present so
  // the remaining-conversation estimate matches what was advertised at signup.
  const planRow = (sub as any)?.planKey
    ? await prisma.plan.findUnique({
        where: { key_version: { key: (sub as any).planKey, version: (sub as any).planVersion } },
        select: { id: true, kind: true },
      })
    : null;
  const liveRatios = await resolveEstimation({ planId: planRow?.id ?? null });
  const ratios = ratiosFromSnapshot((sub as any)?.snapshotEstimation, liveRatios);

  // Credit-bucket breakdown, derived from the lots rather than guessed.
  const lots = await prisma.aiUnitLot.findMany({
    where: { tenantId, unitsRemaining: { gt: 0 } },
    select: { bucket: true, grantType: true, unitsRemaining: true, expiresAt: true },
  });
  const bucketTotals: Record<string, number> = { PLAN: 0, PURCHASE: 0, AUTO: 0, PROMO: 0, TRIAL: 0 };
  for (const lot of lots) bucketTotals[lot.grantType] = (bucketTotals[lot.grantType] ?? 0) + Number(lot.unitsRemaining);
  const sources = {
    plan: Math.round(bucketTotals.PLAN),
    purchased: Math.round(bucketTotals.PURCHASE + bucketTotals.AUTO),
    promotional: Math.round(bucketTotals.PROMO),
    trialOrPoc: Math.round(bucketTotals.TRIAL),
  };

  const evaluation =
    planRow?.kind === "POC" || planRow?.kind === "TRIAL"
      ? {
          kind: planRow.kind,
          expiresAt: periodEnd,
          creditCap: includedCredits,
          selfRenew: false,
        }
      : null;

  res.json({
    period: {
      startsAt: (sub as any)?.currentPeriodStart ?? null,
      endsAt: periodEnd,
      resetsAt: periodEnd,
    },
    plan: {
      planId: (sub as any)?.planKey ?? null,
      name: (plan as any)?.name ?? (sub as any)?.planKey ?? null,
      includedCredits,
    },
    usage: {
      consumedCredits: Math.round(consumedCredits),
      remainingPlanCredits: Math.round(balance.includedRemaining),
      consumedPct:
        balance.includedAllowance > 0
          ? Math.min(100, Math.max(0, Math.round((consumedCredits / balance.includedAllowance) * 100)))
          : 0,
    },
    purchasedCredits: {
      balance: Math.round(balance.purchasedRemaining),
    },
    totalAvailableCredits: Math.round(balance.total),
    // Where the remaining credits came from. The ledger is the source of truth
    // for the numbers; this is the breakdown behind the single total.
    creditSources: sources,
    // Capacity the balance still buys, using the PUBLIC commercial ratio. The
    // credit balance itself stays authoritative - this is an estimate of what it
    // buys, not a second balance.
    estimatedRemaining: {
      chats: estimateRemainingConversations(balance.total, ratios, "chat"),
      calls: estimateRemainingConversations(balance.total, ratios, "voice"),
      ratios: {
        chatCreditsPerEstimatedConversation: ratios.chatCreditsPerEstimatedConversation,
        voiceCreditsPerEstimatedCall: ratios.voiceCreditsPerEstimatedCall,
        businessDaysPerMonth: ratios.businessDaysPerMonth,
      },
    },
    disclaimer: ESTIMATE_DISCLAIMER,
    // Evaluation access, when this is a POC or Trial rather than a paid plan.
    evaluation: evaluation,
    usageCredits: {
      enabled: Boolean(policy?.enabled),
      spentAmount: spentAmount.toFixed(2),
      currency: policy?.currency ?? "USD",
      // Normalized money string ("500.00"): a raw Prisma Decimal JSON-encodes
      // as "500", which is not a stable money format for clients.
      monthlySpendLimit: policy?.maxMonthlySpend != null ? Number(policy.maxMonthlySpend).toFixed(2) : null,
      thresholdPct: policy?.thresholdPct ?? null,
      warningThresholdPct: policy?.warningThresholdPct ?? null,
      incrementCredits: policy?.incrementCredits ?? null,
      pricePerCredit: policy?.pricePerCredit != null ? Number(policy.pricePerCredit).toFixed(6) : null,
      // What actually happens at the limit, so the customer sees the configured
      // behaviour instead of guessing.
      limitBehavior: policy?.limitBehavior ?? "STOP_AI",
      resetsAt: periodEnd,
    },
  });
});

/** Separate INCLUDED (resets) vs PURCHASED (permanent) balances for the UI. */
router.get("/billing/credits/balance", authenticate, resolveTenant, async (req, res) => {
  const b = await getBalance(req.tenantId!);
  res.json({
    includedRemaining: b.includedRemaining,
    purchasedRemaining: b.purchasedRemaining,
    total: b.total,
    includedAllowance: b.includedAllowance,
    // Clamped to 0..100: purchased units can push total ABOVE the allowance
    // (which is legitimately "0% consumed"), never below zero percent.
    consumedPct: b.includedAllowance > 0 ? Math.min(100, Math.max(0, Math.round((1 - b.total / b.includedAllowance) * 100))) : 0,
    periodKey: b.periodKey,
  });
});

router.get("/billing/credits/packages", authenticate, async (_req, res) => {
  const packages = await prisma.creditPackage.findMany({ where: { active: true }, orderBy: { units: "asc" } });
  res.json({ packages });
});

router.post("/billing/credits/buy", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { packageKey, quantity, intentKey } = req.body ?? {};
  if (!packageKey) return res.status(400).json({ error: "packageKey required" });
  // Only the package KEY, a quantity and an intent key are accepted. Price and
  // credit amount are read from the catalog inside buyCredits(), never from the
  // request. The intent key identifies ONE purchase the customer decided on, so
  // a double-click is one charge - it cannot be used to change what is bought.
  const result = await buyCredits({
    tenantId: req.tenantId!,
    packageKey,
    quantity: quantity != null ? Number(quantity) : 1,
    intentKey: typeof intentKey === "string" ? intentKey.slice(0, 64) : undefined,
    actor: req.user?.userId,
  });
  if (result.outcomeUnknown) {
    // 409, not 402. A payment-required response invites the customer to try
    // again, and they may already have been charged.
    return res.status(409).json({ ...result, error: "payment_outcome_unknown" });
  }
  return res.status(result.success ? 200 : 402).json(result);
});

router.get("/billing/auto-purchase", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const entityId = await getEntityIdForTenant(req.tenantId!);
  const policy = entityId ? await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } }) : null;
  res.json({ policy });
});

const LIMIT_BEHAVIORS = ["STOP_AI", "HUMAN_ONLY", "REQUIRE_APPROVAL", "PREPAID_ONLY"] as const;

router.put("/billing/auto-purchase", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const {
    enabled, thresholdPct, packageKey, maxMonthlySpend, currency,
    warningThresholdPct, incrementCredits, pricePerCredit, limitBehavior,
  } = req.body ?? {};

  // Auto-purchase eligibility is a PLAN property, so a client that flips the
  // toggle on a plan that does not allow it is refused server-side rather than
  // silently accepted and then ignored at purchase time.
  const sub = await getSubscriptionForTenant(req.tenantId!);
  if (enabled && sub) {
    const plan = await prisma.plan.findUnique({
      where: { key_version: { key: (sub as any).planKey, version: (sub as any).planVersion } },
      select: { autoPurchaseEligible: true },
    });
    if (plan && !plan.autoPurchaseEligible) {
      return res.status(402).json({
        code: "PLAN_FEATURE_REQUIRED",
        feature: "billing.auto_purchase",
        currentPlan: (sub as any).planKey,
        upgradePath: "/settings/billing/plan",
      });
    }
  }

  if (limitBehavior != null && !LIMIT_BEHAVIORS.includes(limitBehavior)) {
    return res.status(400).json({ error: "invalid_limit_behavior" });
  }

  const entityId = await ensureBillableEntity(req.tenantId!);
  const clampPct = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : fallback;
  };
  const fields = {
    enabled: Boolean(enabled),
    thresholdPct: clampPct(thresholdPct, 10),
    warningThresholdPct: clampPct(warningThresholdPct, 80),
    packageKey: packageKey ?? null,
    incrementCredits: incrementCredits != null ? Math.max(0, Math.floor(Number(incrementCredits))) : null,
    pricePerCredit: pricePerCredit != null ? Number(pricePerCredit).toFixed(6) : null,
    // A null ceiling means unlimited, which is a decision the customer has to
    // make explicitly rather than get by omitting a field.
    maxMonthlySpend: maxMonthlySpend != null ? Number(maxMonthlySpend).toFixed(2) : null,
    ...(limitBehavior ? { limitBehavior } : {}),
    updatedBy: req.user?.userId,
  };

  const policy = await prisma.autoPurchasePolicy.upsert({
    where: { billableEntityId: entityId },
    create: { billableEntityId: entityId, currency: currency ?? "USD", ...fields },
    update: { ...(currency ? { currency } : {}), ...fields },
  });
  res.json({ ok: true, policy });
});

export default router;
