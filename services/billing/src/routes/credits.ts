/**
 * AI-Unit balance, credit packages, manual purchase, and the auto-purchase
 * policy. Balance is read-only for any authenticated tenant member; purchases
 * and policy changes are owner-gated.
 */
import { Router } from "express";
import { authenticate, resolveTenant, requirePermission, prisma, getBalance } from "@chatcenter/shared";
import { ensureBillableEntity, getEntityIdForTenant } from "../services/billable-entity.service";
import { buyCredits } from "../services/purchase.service";

const router = Router();

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
