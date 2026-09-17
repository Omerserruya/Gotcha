import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  allowanceSchema,
  billingSummarySchema,
  plansResponseSchema,
  subscriptionResponseSchema,
  usageBreakdownSchema,
  type Allowance,
  type BillingSummary,
  type Plan,
  type Subscription,
  type UsageBreakdown,
} from '@/api/contracts/billing';
import { billingEndpoints, usageEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 17 shows.
 *
 * Four reads, independent. The billing summary and the usage breakdown are
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
export interface BillingData {
  readonly allowance: Allowance | null;
  readonly subscription: Subscription | null;
  /**
   * Plan names by key. The subscription carries `planKey` — `ai_voice` — and a
   * machine identifier must never be the most prominent line on a billing
   * screen. The list is also where the Hebrew name lives.
   */
  readonly plans: readonly Plan[];
  readonly summary: BillingSummary | null;
  readonly breakdown: UsageBreakdown | null;
}

export async function loadBilling(): Promise<BillingData> {
  const api = serverApi();

  const [allowance, subscription, plans, summary, breakdown] = await Promise.all([
    api
      .get({ endpoint: usageEndpoints.allowance(), payload: allowanceSchema })
      .catch((cause: unknown) => {
        logger.warn('billing.allowance_failed', { cause });
        return null;
      }),
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
      .get({ endpoint: billingEndpoints.summary(), payload: billingSummarySchema })
      .catch((cause: unknown) => {
        logger.warn('billing.summary_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: usageEndpoints.breakdown(), payload: usageBreakdownSchema })
      .catch((cause: unknown) => {
        logger.warn('billing.breakdown_failed', { cause });
        return null;
      }),
  ]);

  return {
    allowance,
    subscription: subscription?.subscription ?? null,
    plans: plans?.plans ?? [],
    summary,
    breakdown,
  };
}
