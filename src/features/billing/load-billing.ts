import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  plansResponseSchema,
  subscriptionResponseSchema,
  usageBreakdownSchema,
  type Plan,
  type Subscription,
  type UsageBreakdown,
} from '@/api/contracts/billing';
import { billingEndpoints, usageEndpoints } from '@/api/endpoints/registry';
import { autoPurchaseResponseSchema } from '@/api/contracts/auto-purchase';
import {
  billingProfileResponseSchema,
  paymentMethodListSchema,
  type BillingProfile,
  type PaymentMethod,
} from '@/api/contracts/billing-profile';
import { creditSummarySchema, type CreditSummary } from '@/api/contracts/credits';
import { packagesResponseSchema, type PackagesResponse } from '@/api/contracts/pricing';
import { invoiceListSchema, type Invoice } from '@/api/contracts/invoices';
import { logger } from '@/observability/logger';

/**
 * What screen 17 shows.
 *
 * Four reads, independent. The invoices and the usage breakdown are
 * deliberately separate: they change on completely different cadences — one on
 * invoice issue, the other continuously — and a failure in either must not
 * blank the other.
 *
 * Two of the four are contracted and not yet served, so they arrive `null` and
 * their sections say so. As everywhere on this project, that is kept distinct
 * from "there is nothing": an empty invoice list and an unreachable one are
 * different facts, and on a billing screen the second is the one worth
 * knowing.
 */
type AutoPurchaseData = Awaited<ReturnType<typeof autoPurchaseResponseSchema.parse>>;

export interface BillingData {
  readonly subscription: Subscription | null;
  /**
   * Plan names by key. The subscription carries `planKey` — `ai_voice` — and a
   * machine identifier must never be the most prominent line on a billing
   * screen. The list is also where the Hebrew name lives.
   */
  readonly plans: readonly Plan[];
  /**
   * The tenant's invoices.
   *
   * Replaces the old `summary`, which pointed at `/api/billing/summary` —
   * annotated "contracted, not yet served" while `/api/billing/invoices` was
   * mounted and returning four FAILED charges worth $5,996.
   */
  readonly invoices: readonly Invoice[] | null;
  readonly breakdown: UsageBreakdown | null;
  /**
   * What happens when the credit runs out — screen 17d.
   *
   * `null` policy means nothing has been configured, which is NOT the same
   * as a policy of defaults: the difference decides whether "buys more at
   * 10%" is a fact about this tenant or a guess about one.
   */
  readonly autoPurchase: AutoPurchaseData | null;
  /** Who the bill is made out to — screen 17e. Null means no row at all. */
  readonly profile: BillingProfile | null;
  /** What it charges against. Empty means there is nothing to charge. */
  readonly paymentMethods: readonly PaymentMethod[] | null;
  /**
   * Credits and what they buy — screen 17c.
   *
   * Bare, not enveloped. Carries TWO estimates of remaining capacity from
   * different bases, which the route insists must never be substituted for
   * one another.
   */
  readonly credits: CreditSummary | null;
  /** Screen 17d. Null when the read failed, which is not "none on sale". */
  readonly packages: PackagesResponse | null;
}

export async function loadBilling(): Promise<BillingData> {
  const api = serverApi();

  const [
    subscription,
    plans,
    invoices,
    breakdown,
    autoPurchase,
    profile,
    paymentMethods,
    credits,
    packages,
  ] = await Promise.all([
    api
      .get({
        endpoint: billingEndpoints.subscription(),
        payload: subscriptionResponseSchema,
        // Bare `{ subscription }`, not `{ data }` — unlike its siblings.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.subscription_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: billingEndpoints.plans(), payload: plansResponseSchema, raw: true })
      .catch((cause: unknown) => {
        // Losing this costs the plan its NAME, not the screen. The line falls
        // back to the key, which is ugly and still true.
        logger.warn('billing.plans_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.invoices(),
        payload: invoiceListSchema,
        // `{ invoices }` — a fifth envelope shape, so the transform needs the
        // response whole.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.invoices_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: usageEndpoints.breakdown(), payload: usageBreakdownSchema })
      .catch((cause: unknown) => {
        logger.warn('billing.breakdown_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.autoPurchase(),
        payload: autoPurchaseResponseSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.auto_purchase_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.profile(),
        payload: billingProfileResponseSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.profile_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.paymentMethods(),
        payload: paymentMethodListSchema,
        // `{ paymentMethods }` — a sixth envelope shape.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.payment_methods_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: billingEndpoints.creditSummary(),
        payload: creditSummarySchema,
        // Bare, like the subscription. A seventh shape would be a stretch —
        // this one simply has no envelope at all.
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('billing.credit_summary_failed', { cause });
        return null;
      }),
    /*
     * Screen 17d. Read HERE rather than on the plan page, although the plan
     * page already reads it: buying belongs beside the balance somebody has
     * just read, and the two facts that decide whether the button can work —
     * the billing profile and the payment methods — are already loaded on
     * this page. Fetching packages here costs one extra request; doing it the
     * other way round would cost two, against a 1,000-per-fifteen-minutes
     * window that a billing page already spends six of per load.
     *
     * ★ AND THIS IS `pricing/packages`, NOT `credits/packages`. The second
     * route filters on `active` alone — no `customerVisible`, no `status`, no
     * plan-eligibility gate — so it can list packages a customer must not see
     * or cannot buy. Two routes, similar paths, different answers: the shape
     * that made /api/knowledge look alive for a whole screen.
     */
    api
      .get({ endpoint: billingEndpoints.pricingPackages(), payload: packagesResponseSchema })
      .catch((cause: unknown) => {
        logger.warn('billing.packages_failed', { cause });
        return null;
      }),
  ]);

  return {
    subscription: subscription?.subscription ?? null,
    plans: plans?.plans ?? [],
    invoices,
    autoPurchase,
    profile,
    paymentMethods,
    breakdown,
    credits,
    packages,
  };
}
