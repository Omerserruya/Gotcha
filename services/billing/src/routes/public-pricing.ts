/**
 * PUBLIC pricing catalog - unauthenticated, cacheable, marketing-facing.
 *
 * This is the only pricing route that answers without a token, so it is the one
 * route where a leak is a public leak. Three deliberate choices:
 *
 *   1. It reuses the canonical pricing service and estimation engine. There is
 *      no second calculation anywhere - the marketing site and the authenticated
 *      configurator quote from the same code, so they cannot disagree.
 *
 *   2. It WHITELISTS every field it emits rather than deleting the private ones.
 *      Adding a field to PlanView must not silently publish it; a new internal
 *      field simply will not appear here until someone adds it on purpose.
 *
 *   3. It resolves NO tenant. `listCatalogPlans()` without a tenantId returns
 *      only ACTIVE + PUBLIC plans, so custom plans, POC, Trial, drafts and
 *      retired versions are excluded by the query itself, not by a filter that
 *      could be forgotten.
 *
 * The response is shared across every visitor, so nothing tenant-specific may
 * ever enter it - that is what would poison a CDN cache for everyone.
 */
import { Router } from "express";
import {
  prisma,
  getCurrencyConfig,
  getUsdIlsRate,
  ESTIMATE_DISCLAIMER,
  getFeatureDef,
  isUnsellable,
} from "@chatcenter/shared";
import { listCatalogPlans, type PlanView } from "../services/pricing.service";

const router = Router();

/**
 * Deployment flag. Default FALSE, including in production - provisional prices
 * must never be reachable publicly by accident. Enabling it is an explicit
 * deployment decision, and nginx enforces the same flag for the page itself so
 * the gate does not depend on the browser running any JavaScript.
 */
export function publicPricingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PUBLIC_PRICING_ENABLED ?? "false").toLowerCase() === "true";
}

/** Seconds a shared cache may serve this response. */
const CACHE_SECONDS = parseInt(process.env.PUBLIC_PRICING_CACHE_SECONDS || "120", 10);

// ── Public projections ──────────────────────────────────────────────────────

interface PublicVolumeOption {
  key: string;
  channel: "CHAT" | "VOICE";
  dailyVolume: number;
  monthlyVolume: number;
  additionalCredits: number;
  additionalPrice: PublicPrice;
  isDefault: boolean;
  totalChannelCredits: number;
}

interface PublicPrice {
  amount: string;
  currency: string;
  formatted: string;
  base: { amount: string; currency: string; formatted: string };
  isEstimatedConversion: boolean;
  chargedCurrency: string;
}

interface PublicFeature {
  key: string;
  name: string;
  nameEn: string;
  nameHe: string;
  description: string | null;
  category: string;
  included: boolean;
}

interface PublicPlan {
  key: string;
  version: number;
  name: string;
  nameHe: string | null;
  description: string | null;
  descriptionHe: string | null;
  recommended: boolean;
  sortOrder: number;
  salesOnly: boolean;
  billingInterval: string;
  price: PublicPrice | null;
  includedCredits: number;
  creditSplit: { chat: number; voice: number };
  supportLevel: string | null;
  chatVolumeEnabled: boolean;
  voiceVolumeEnabled: boolean;
  autoPurchaseEligible: boolean;
  creditPackagesEligible: boolean;
  features: PublicFeature[];
  limits: Record<string, number>;
  chatOptions: PublicVolumeOption[];
  voiceOptions: PublicVolumeOption[];
  estimate: PublicEstimate;
}

interface PublicChannelEstimate {
  credits: number;
  monthly: number;
  daily: number;
  /** "DECLARED_VOLUME" = the volume this plan sells; "CREDIT_RATIO" = derived. */
  basis: string;
  creditsPerUnit: number;
}

interface PublicEstimate {
  chat: PublicChannelEstimate;
  voice: PublicChannelEstimate;
  totalInteractions: number;
  pricePerChat: string | null;
  pricePerCall: string | null;
  pricePerInteraction: string | null;
  currency: string;
  ratios: {
    chatCreditsPerEstimatedConversation: number;
    voiceCreditsPerEstimatedCall: number;
    businessDaysPerMonth: number;
  };
}

/**
 * Flatten a DisplayPrice into the public shape.
 *
 * Keeps BOTH the display amount and the canonical base amount, because a
 * visitor being shown shekels still has to be told what will actually be
 * charged before they act.
 */
function toPublicPrice(p: PlanView["basePrice"]): PublicPrice | null {
  if (!p) return null;
  return {
    amount: p.display.amount,
    currency: p.display.currency,
    formatted: p.display.formatted,
    base: { amount: p.base.amount, currency: p.base.currency, formatted: p.base.formatted },
    isEstimatedConversion: p.isEstimatedConversion,
    chargedCurrency: p.chargedCurrency,
  };
}

function toPublicVolume(o: PlanView["chatOptions"][number]): PublicVolumeOption {
  return {
    key: o.key,
    channel: o.channel,
    dailyVolume: o.dailyVolume,
    monthlyVolume: o.monthlyVolume,
    additionalCredits: o.additionalCredits,
    additionalPrice: toPublicPrice(o.additionalPrice)!,
    isDefault: o.isDefault,
    totalChannelCredits: o.totalChannelCredits,
  };
}

/**
 * Public feature projection.
 *
 * Drops anything unsellable or not customer-visible. A capability the product
 * has not built cannot appear on a public pricing page at all - not as
 * "unavailable", not as a greyed row, not anywhere.
 */
function toPublicFeatures(features: PlanView["features"], locale: string): PublicFeature[] {
  const out: PublicFeature[] = [];
  for (const f of features) {
    if (isUnsellable(f.key)) continue;
    const def = getFeatureDef(f.key);
    if (!def || !def.customerVisible || def.sysadminOnly) continue;
    out.push({
      key: f.key,
      name: locale === "he" ? f.nameHe : f.nameEn,
      nameEn: f.nameEn,
      nameHe: f.nameHe,
      description: locale === "he" ? def.descriptionHe : def.descriptionEn,
      category: f.category,
      included: f.included,
    });
  }
  return out;
}

function toPublicPlan(p: PlanView, locale: string): PublicPlan {
  return {
    key: p.key,
    version: p.version,
    name: p.name,
    nameHe: p.nameHe,
    description: p.description,
    descriptionHe: p.descriptionHe,
    recommended: p.recommended,
    sortOrder: p.sortOrder,
    salesOnly: p.salesOnly,
    billingInterval: p.billingInterval,
    price: toPublicPrice(p.basePrice),
    includedCredits: p.includedCredits,
    creditSplit: p.creditSplit,
    supportLevel: p.supportLevel,
    chatVolumeEnabled: p.chatVolumeEnabled,
    voiceVolumeEnabled: p.voiceVolumeEnabled,
    autoPurchaseEligible: p.autoPurchaseEligible,
    creditPackagesEligible: p.creditPackagesEligible,
    features: toPublicFeatures(p.features, locale),
    limits: p.limits,
    chatOptions: p.chatOptions.map(toPublicVolume),
    voiceOptions: p.voiceOptions.map(toPublicVolume),
    estimate: p.estimate as PublicEstimate,
    // NOTE: `kind`, `tenantId`, `internalNote`, `publishedBy`, `effectiveFrom`,
    // `approvalState` and subscriber counts are deliberately absent. This is a
    // whitelist - adding a field to PlanView does not publish it.
  };
}

// ── Cache validator ─────────────────────────────────────────────────────────

/**
 * A weak ETag derived from the newest publish/update timestamp across
 * everything the response depends on.
 *
 * Publishing a new PlanVersion, a new estimation config, or a currency change
 * moves one of these timestamps, so the ETag changes and caches refetch. Without
 * this, a short max-age would still serve the old catalog for its full window
 * after a publish.
 */
async function catalogVersionTag(displayCurrency: string, locale: string): Promise<string> {
  const [plan, estimation, currency, fx] = await Promise.all([
    prisma.plan.findFirst({
      where: { status: "ACTIVE", kind: "PUBLIC" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.publicEstimationConfig.findFirst({
      where: { active: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.pricingCurrencyConfig.findFirst({ where: { active: true }, select: { updatedAt: true } }),
    prisma.fxRateSnapshot.findFirst({ orderBy: { fetchedAt: "desc" }, select: { fetchedAt: true } }),
  ]);
  const parts = [
    plan?.updatedAt?.getTime() ?? 0,
    estimation?.createdAt?.getTime() ?? 0,
    currency?.updatedAt?.getTime() ?? 0,
    fx?.fetchedAt?.getTime() ?? 0,
    displayCurrency,
    locale,
  ];
  return `W/"pricing-${parts.join("-")}"`;
}

// ── Route ───────────────────────────────────────────────────────────────────

/**
 * The public catalog.
 *
 * 404 when the flag is off, deliberately - a disabled pricing page should look
 * like it does not exist rather than like a locked door, and a 404 leaks no
 * configuration.
 */
router.get("/public/pricing", async (req, res) => {
  if (!publicPricingEnabled()) {
    return res.status(404).json({ error: "not_found" });
  }

  try {
    const cfg = await getCurrencyConfig();
    const requested = typeof req.query.currency === "string" ? req.query.currency.toUpperCase() : cfg.baseCurrency;
    const display = cfg.displayCurrencies.includes(requested) ? requested : cfg.baseCurrency;
    const locale = req.query.locale === "he" ? "he" : "en";

    const etag = await catalogVersionTag(display, locale);
    // Shared cache only - this response is identical for every visitor because
    // it resolves no tenant. `must-revalidate` keeps a stale catalog from
    // outliving a publish.
    res.setHeader("Cache-Control", `public, max-age=${CACHE_SECONDS}, must-revalidate`);
    res.setHeader("ETag", etag);
    res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    // No tenantId: the query returns ACTIVE + PUBLIC only. Custom, POC, Trial,
    // DRAFT and RETIRED versions never enter the result set.
    const plans = await listCatalogPlans({ tenantId: null, displayCurrency: display });

    const fx = display === cfg.baseCurrency ? null : await getUsdIlsRate();

    return res.json({
      enabled: true,
      plans: plans.map((p) => toPublicPlan(p, locale)),
      currency: {
        base: cfg.baseCurrency,
        display,
        available: cfg.displayCurrencies,
        // The UI keys its "estimated conversion" label off this rather than
        // assuming which currency is charged.
        isEstimatedConversion: display !== cfg.baseCurrency && !cfg.chargeInDisplayCurrency,
        chargedCurrency: cfg.chargeInDisplayCurrency ? display : cfg.baseCurrency,
        ilsRoundingIncrement: cfg.ilsRoundingIncrement,
        fx: fx ? { rate: fx.rate, source: fx.source, rateDate: fx.rateDate, isFallback: fx.isFallback } : null,
      },
      disclaimer: ESTIMATE_DISCLAIMER,
    });
  } catch (err: any) {
    // Never leak a stack trace or configuration detail on a public route.
    console.error("[public-pricing] failed:", err?.message ?? err);
    return res.status(503).json({ error: "pricing_unavailable" });
  }
});

export default router;
