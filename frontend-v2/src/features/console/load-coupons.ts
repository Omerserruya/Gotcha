import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { couponListSchema, type Coupon } from '@/api/contracts/console';
import { couponEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * `/system/coupons` - legacy `system/coupons/page.tsx`: every coupon issued,
 * active first (the service's own order, coupon.service.ts:136). `undefined`
 * when the read failed, never an empty list.
 */
export async function loadCoupons(): Promise<readonly Coupon[] | undefined> {
  try {
    const body = await serverApi().get({
      endpoint: couponEndpoints.list(),
      payload: couponListSchema,
    });
    return body.coupons;
  } catch (cause) {
    logger.warn('console.coupons_failed', { cause });
    return undefined;
  }
}
