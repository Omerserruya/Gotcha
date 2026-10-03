import 'server-only';

import { subscriptionResponseSchema, type Subscription } from '@/api/contracts/billing';
import {
  currencyBlockSchema,
  packagesResponseSchema,
  type CurrencyBlock,
  type PackagesResponse,
  catalogPlans,
  type CatalogPlan,
} from '@/api/contracts/pricing';
import { paymentMethodListSchema, type PaymentMethod } from '@/api/contracts/billing-profile';
import { billingEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';
import { z } from 'zod';

/**
 * What screen 17b shows — plan, price, and what changing it would do.
 *
 * Four reads, independent, each degrading on its own. The payment methods are
 * here for a reason that is not obvious: an upgrade charges the prorated
 * difference **before** granting anything, resolving the card as
 * `paymentMethods[0]?.id ?? "nocard"`. With none, the charge cannot succeed.
 * So the count decides whether this screen offers an upgrade or explains why
 * it would be declined — that is a fact about the change flow, not about the
 * billing profile, which is why it is read here rather than assumed.
 */

/** `/billing/pricing` — the catalogue plus the currency and FX attribution. */
const pricingResponseSchema = z.object({
  /** 17b's cards. Read plan by plan in `catalogPlans`. */
  plans: z.unknown().default([]),
  currency: currencyBlockSchema,
  currentPlanKey: z.string().nullable().default(null),
  tax: z
    .object({
      ratePct: z.number().nullable().default(null),
      label: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * The platform's own disclaimer, per locale.
   *
   * Rendered rather than translated here: this is the sentence the public
   * pricing pages show, and a second Hebrew version of a commercial claim can
   * drift from it with nothing failing.
   */
  disclaimer: z
    .object({ en: z.string().default(''), he: z.string().default('') })
    .nullable()
    .default(null),
});

export interface PricingData {
  readonly subscription: Subscription | null;
  readonly currency: CurrencyBlock | null;
  readonly tax: { ratePct: number | null; label: string | null } | null;
  readonly disclaimer: { en: string; he: string } | null;
  readonly packages: PackagesResponse | null;
  /** How many cards are on file. Zero means an upgrade will be declined. */
  readonly paymentMethods: readonly PaymentMethod[] | null;
  /** The catalog, `[]` when the read failed or held nothing readable. */
  readonly catalog: readonly CatalogPlan[];
}

export async function loadPricing(): Promise<PricingData> {
  const api = serverApi();

  const [subscription, pricing, packages, paymentMethods] = await Promise.all([
    api
      .get({
        endpoint: billingEndpoints.subscription(),
        payload: subscriptionResponseSchema,
        // Bare `{ subscription }`. It carries `pendingChange` — the relation
        // is included by `getSubscriptionForTenant`, which is the only place
        // a scheduled change reaches a customer.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('pricing.subscription_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: billingEndpoints.pricing(), payload: pricingResponseSchema, raw: true })
      .catch((cause: unknown) => {
        logger.warn('pricing.catalog_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.pricingPackages(),
        payload: packagesResponseSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        // Losing this must not become "your plan cannot buy credits", which is
        // a statement about their plan. Null is "we could not find out".
        logger.warn('pricing.packages_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.paymentMethods(),
        payload: paymentMethodListSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('pricing.payment_methods_failed', { cause });
        return null;
      }),
  ]);

  return {
    subscription: subscription?.subscription ?? null,
    currency: pricing?.currency ?? null,
    tax: pricing?.tax ?? null,
    disclaimer: pricing?.disclaimer ?? null,
    packages,
    paymentMethods,
    catalog: catalogPlans(pricing?.plans),
  };
}
