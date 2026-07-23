/**
 * AI-Unit balance, credit packages, manual purchase, and the auto-purchase
 * policy. Balance is read-only for any authenticated tenant member; purchases
 * and policy changes are owner-gated.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma, getBalance } from "@chatcenter/shared";
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

  const includedCredits = plan
    ? Math.round((plan as any).includedAiUnits ?? 0)
    : Math.round(balance.includedAllowance);
  const consumedCredits = Math.max(0, balance.includedAllowance - balance.includedRemaining);
  const periodEnd = (sub as any)?.currentPeriodEnd ?? null;

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
    usageCredits: {
      enabled: Boolean(policy?.enabled),
      spentAmount: spentAmount.toFixed(2),
      currency: policy?.currency ?? "ILS",
      // Normalized money string ("500.00"): a raw Prisma Decimal JSON-encodes
      // as "500", which is not a stable money format for clients.
      monthlySpendLimit: policy?.maxMonthlySpend != null ? Number(policy.maxMonthlySpend).toFixed(2) : null,
      thresholdPct: policy?.thresholdPct ?? null,
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
  const { packageKey } = req.body ?? {};
  if (!packageKey) return res.status(400).json({ error: "packageKey required" });
  const result = await buyCredits({ tenantId: req.tenantId!, packageKey, actor: req.user?.userId });
  return res.status(result.success ? 200 : 402).json(result);
});

router.get("/billing/auto-purchase", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const entityId = await getEntityIdForTenant(req.tenantId!);
  const policy = entityId ? await prisma.autoPurchasePolicy.findUnique({ where: { billableEntityId: entityId } }) : null;
  res.json({ policy });
});

router.put("/billing/auto-purchase", authenticate, resolveTenant, requirePermission("settings:billing:manage"), async (req, res) => {
  const { enabled, thresholdPct, packageKey, maxMonthlySpend, currency } = req.body ?? {};
  const entityId = await ensureBillableEntity(req.tenantId!);
  const policy = await prisma.autoPurchasePolicy.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      enabled: Boolean(enabled),
      thresholdPct: thresholdPct ?? 10,
      packageKey: packageKey ?? null,
      maxMonthlySpend: maxMonthlySpend != null ? Number(maxMonthlySpend).toFixed(2) : null,
      currency: currency ?? "ILS",
      updatedBy: req.user?.userId,
    },
    update: {
      enabled: Boolean(enabled),
      thresholdPct: thresholdPct ?? 10,
      packageKey: packageKey ?? null,
      maxMonthlySpend: maxMonthlySpend != null ? Number(maxMonthlySpend).toFixed(2) : null,
      ...(currency ? { currency } : {}),
      updatedBy: req.user?.userId,
    },
  });
  res.json({ ok: true, policy });
});

export default router;
