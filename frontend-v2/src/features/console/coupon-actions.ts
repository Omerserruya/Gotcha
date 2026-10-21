'use server';

import { z } from 'zod';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { COUPON_REFUSALS, type CouponRefusalCode } from '@/api/contracts/console';
import { couponEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The console's coupon writes (billing `routes/admin-coupons.ts`). A coupon
 * changes what a customer is CHARGED for as long as its window is open, so
 * every write is a billing write: held unless `BILLING_WRITES=on`, refused
 * here before any call. Mocked in every test.
 *
 * The route answers a refusal as `400 { error: <code> }` from a fixed list
 * (`refusal()`, admin-coupons.ts:42) - each is its own sentence on screen.
 */
export type CouponWrite =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: CouponRefusalCode | 'held' | 'forbidden' | 'failed';
    };

/** After `signInIfSignedOut` in the catch: a 401 never reaches here. */
async function refusalOf(cause: unknown, event: string): Promise<CouponWrite & { ok: false }> {
  if (isApiError(cause)) {
    const code = cause.developerMessage;
    if (code && (COUPON_REFUSALS as readonly string[]).includes(code)) {
      return { ok: false, reason: code as CouponRefusalCode };
    }
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
  }
  logger.warn(event, { cause });
  return { ok: false, reason: 'failed' };
}

/**
 * Give one coupon to one tenant (admin-coupons.ts:129). `months` null is the
 * coupon's own default window; the route resolves the end date once, on the
 * row. By coupon id only - never a code typed here.
 */
export async function assignTenantCoupon(
  tenantId: string,
  couponId: string,
  months: number | null,
): Promise<CouponWrite> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    await serverApi().post({
      endpoint: couponEndpoints.tenant(tenantId),
      body: { couponId, durationMonths: months },
      payload: z.unknown(),
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.coupon_assign_failed');
  }
}

/** Stop one assignment (admin-coupons.ts:161): the next charge is the full price. */
export async function revokeTenantCoupon(assignmentId: string): Promise<CouponWrite> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    await serverApi().delete({
      endpoint: couponEndpoints.assignment(assignmentId),
      payload: z.unknown(),
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.coupon_revoke_failed');
  }
}
