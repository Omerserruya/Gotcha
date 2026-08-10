/**
 * Customer-facing pricing catalog + configurator.
 *
 * Everything here speaks CREDITS, prices and estimated conversation volumes.
 * Nothing here returns tokens, provider cost, margin, the unit-cost basis, or
 * any actual-usage statistic - those live behind the Sysadmin routes and are
 * covered by a regression test that scans these responses.
 *
 * Prices are never accepted from the client. `/quote` takes plan and volume
 * KEYS and recomputes every number from the catalog.
 */
import { Router } from "express";
import {
  authenticate,
  resolveTenant,
  requirePermission,
  prisma,
  getCurrencyConfig,
  getUsdIlsRate,
  ESTIMATE_DISCLAIMER,
} from "@chatcenter/shared";
import { listCatalogPlans, quote, describeSubscription, taxSummaryForTenant } from "../services/pricing.service";
import { applyTax } from "../services/tax.service";
import { getSubscriptionForTenant } from "../services/billable-entity.service";
import { packageAvailable, effectivePackagePrice } from "../services/purchase.service";

const router = Router();

/** The display currency the client asked for, constrained to what is configured. */
async function displayCurrency(raw: unknown): Promise<string> {
  const cfg = await getCurrencyConfig();
  const requested = typeof raw === "string" ? raw.toUpperCase() : cfg.baseCurrency;
  return cfg.displayCurrencies.includes(requested) ? requested : cfg.baseCurrency;
}

/**
 * The pricing page payload: the plan catalog, the display-currency options and
 * the FX attribution behind an ILS rendering.
 *
 * Tenant-scoped so a custom plan negotiated for this organization appears
 * alongside the public catalog - and no one else's does.
 */
router.get("/billing/pricing", authenticate, resolveTenant, async (req, res) => {
  const display = await displayCurrency(req.query.currency);
  const cfg = await getCurrencyConfig();
  const [plans, sub, fx, tax] = await Promise.all([
    listCatalogPlans({ tenantId: req.tenantId, displayCurrency: display }),
    getSubscriptionForTenant(req.tenantId!),
    display === cfg.baseCurrency ? Promise.resolve(null) : getUsdIlsRate(),
    taxSummaryForTenant(req.tenantId),
  ]);

  res.json({
    plans,
    // Catalogue prices are net. The cards say "+ VAT" off this rather than
    // presenting a number the charge will not match.
    tax,
    currentPlanKey: (sub as any)?.planKey ?? null,
    currentPlanVersion: (sub as any)?.planVersion ?? null,
    currency: {
      base: cfg.baseCurrency,
      display,
      available: cfg.displayCurrencies,
      // The UI keys its "estimated conversion" label off this, rather than
      // assuming which currency is charged.
      isEstimatedConversion: display !== cfg.baseCurrency && !cfg.chargeInDisplayCurrency,
      chargedCurrency: cfg.chargeInDisplayCurrency ? display : cfg.baseCurrency,
      fx: fx ? { rate: fx.rate, source: fx.source, rateDate: fx.rateDate, isFallback: fx.isFallback } : null,
    },
    disclaimer: ESTIMATE_DISCLAIMER,
  });
});

/**
 * Price a concrete selection. The body carries KEYS only; price, credits and
 * estimate are all recomputed server-side from the catalog.
 */
router.post("/billing/pricing/quote", authenticate, resolveTenant, async (req, res) => {
  const { planKey, chatVolumeOptionKey, voiceVolumeOptionKey } = req.body ?? {};
  if (!planKey) return res.status(400).json({ error: "planKey required" });
  try {
    const display = await displayCurrency(req.body?.currency ?? req.query.currency);
    const q = await quote({
      planKey: String(planKey),
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
      tenantId: req.tenantId,
      displayCurrency: display,
    });
    return res.json({
      planKey: q.planKey,
      planVersion: q.planVersion,
      chatVolumeOptionKey: q.chatVolumeOptionKey,
      voiceVolumeOptionKey: q.voiceVolumeOptionKey,
      monthlyPrice: q.monthlyPriceDisplay,
      includedCredits: q.includedCredits,
      estimate: q.estimate,
      // Catalogue prices are NET, so the figure above is not what leaves the
      // card. The three numbers travel together or the page shows a total
      // nobody can check against the one on their statement.
      tax: q.tax,
      disclaimer: ESTIMATE_DISCLAIMER,
    });
  } catch (err: any) {
    const msg = err?.message ?? "quote_failed";
    return res.status(msg.startsWith("unknown_") || msg === "plan_not_available" ? 404 : 400).json({ error: msg });
  }
});

/**
 * The current subscription rendered from its stored snapshot, so a published
 * plan change never restates what an existing customer sees.
 */
router.get("/billing/pricing/current", authenticate, resolveTenant, async (req, res) => {
  const sub = await getSubscriptionForTenant(req.tenantId!);
  if (!sub) return res.json({ subscription: null });
  const display = await displayCurrency(req.query.currency);
  res.json({
    subscription: await describeSubscription(sub, display),
    disclaimer: ESTIMATE_DISCLAIMER,
  });
});

/**
 * The purchasable credit packages for THIS organization's plan.
 *
 * Filters on customer visibility, the active window and plan eligibility, so a
 * retired or plan-restricted package never renders as buyable and then fails at
 * checkout.
 */
router.get("/billing/pricing/packages", authenticate, resolveTenant, async (req, res) => {
  const now = new Date();
  const sub = await getSubscriptionForTenant(req.tenantId!);
  const planKey = (sub as any)?.planKey ?? null;
  const plan = planKey
    ? await prisma.plan.findUnique({
        where: { key_version: { key: planKey, version: (sub as any).planVersion } },
        select: { creditPackagesEligible: true },
      })
    : null;

  if (plan && !plan.creditPackagesEligible) return res.json({ packages: [], eligible: false });

  const rows = await prisma.creditPackage.findMany({
    where: { customerVisible: true, status: "ACTIVE", active: true },
    orderBy: [{ sortOrder: "asc" }, { units: "asc" }],
  });

  const display = await displayCurrency(req.query.currency);
  const { toDisplayPrice, money, toDecimalString } = await import("@chatcenter/shared");

  // Package prices are net, like every catalogue price. Carrying the tax with
  // them is what lets the confirm dialog state the amount that will actually
  // be charged instead of the one on the tile.
  const tax = await taxSummaryForTenant(req.tenantId);

  const packages = [];
  for (const p of rows) {
    if (!packageAvailable(p, planKey, now).ok) continue;
    const price = money(effectivePackagePrice(p, now), p.currency);
    packages.push({
      key: p.key,
      name: p.name,
      nameHe: p.nameHe,
      credits: p.units,
      price: await toDisplayPrice(price, display),
      taxed: applyTax(toDecimalString(price), tax),
      discountLabel: p.discountLabel,
      maxPurchaseQuantity: p.maxPurchaseQuantity,
      expiryPolicy: p.expiryPolicy,
      expiryDays: p.expiryDays,
    });
  }
  res.json({ packages, tax, eligible: true });
});

/**
 * Apply a plan / volume change. Owner-gated, provider-confirmed, and priced
 * from the catalog rather than from anything the client sent.
 */
router.post(
  "/billing/pricing/change",
  authenticate,
  resolveTenant,
  requirePermission("settings:billing:manage"),
  async (req, res) => {
    const { planKey, chatVolumeOptionKey, voiceVolumeOptionKey } = req.body ?? {};
    if (!planKey) return res.status(400).json({ error: "planKey required" });
    try {
      const { changePlan } = await import("../services/subscription.service");
      const result = await changePlan({
        tenantId: req.tenantId!,
        targetPlanKey: String(planKey),
        chatVolumeOptionKey: chatVolumeOptionKey === undefined ? undefined : chatVolumeOptionKey,
        voiceVolumeOptionKey: voiceVolumeOptionKey === undefined ? undefined : voiceVolumeOptionKey,
        actor: req.user?.userId,
      });
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message ?? "change_failed" });
    }
  },
);

export default router;
