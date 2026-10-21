import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { isApiError } from '@/api/client/api-error';
import {
  couponListSchema,
  provisionablePlansSchema,
  provisioningStatusSchema,
  tenantCouponsSchema,
  tenantDetailSchema,
  type Coupon,
  type ProvisionablePlan,
  type ProvisioningStatus,
  type TenantCoupon,
  type TenantDetail,
} from '@/api/contracts/console';
import { consoleEndpoints, couponEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * `/system/tenants/[id]` - legacy `system/tenants/[id]/page.tsx`, the parts
 * in scope: the tenant's facts, its billing oversight and its coupons.
 *
 * Independent reads, each with its own failure: a tenant whose coupons would
 * not load is still a tenant whose billing can be repaired. `undefined` is
 * "the read failed" throughout, never "none".
 */
export interface TenantPageData {
  readonly tenant:
    | { readonly ok: true; readonly value: TenantDetail }
    | { readonly ok: false; readonly missing: boolean };
  /** `null`: no provisioning request ever made. `undefined`: unread. */
  readonly provisioning: ProvisioningStatus | undefined;
  /**
   * Plans a paid plan can be assigned from - read only when the tenant has no
   * plan to speak of (`needsReview`, not two plans), as legacy's banner did.
   */
  readonly plans: readonly ProvisionablePlan[] | undefined;
  readonly coupons: readonly TenantCoupon[] | undefined;
  /** Active coupons, to give one. */
  readonly assignable: readonly Coupon[] | undefined;
}

export async function loadTenant(tenantId: string): Promise<TenantPageData> {
  const api = serverApi();
  const unread =
    (event: string) =>
    (cause: unknown): undefined => {
      logger.warn(event, { cause });
      return undefined;
    };

  const [tenant, provisioning, coupons, allCoupons] = await Promise.all([
    api
      .get({ endpoint: consoleEndpoints.tenant(tenantId), payload: tenantDetailSchema })
      .then((value) => ({ ok: true as const, value }))
      .catch((cause: unknown) => {
        logger.warn('console.tenant_failed', { cause });
        return { ok: false as const, missing: isApiError(cause) && cause.status === 404 };
      }),
    api
      .get({ endpoint: consoleEndpoints.provisioning(tenantId), payload: provisioningStatusSchema })
      .catch(unread('console.provisioning_failed')),
    api
      .get({ endpoint: couponEndpoints.tenant(tenantId), payload: tenantCouponsSchema })
      .then((body) => body.assignments)
      .catch(unread('console.tenant_coupons_failed')),
    api
      .get({ endpoint: couponEndpoints.list(), payload: couponListSchema })
      .then((body) => body.coupons)
      .catch(unread('console.coupons_failed')),
  ]);

  const needsPlan =
    tenant.ok &&
    tenant.value.planAccess.needsReview &&
    tenant.value.planAccess.state !== 'CONFLICTING';
  const plans = needsPlan
    ? await api
        .get({ endpoint: consoleEndpoints.plans(), payload: provisionablePlansSchema })
        .catch(unread('console.plans_failed'))
    : undefined;

  return {
    tenant,
    provisioning,
    plans,
    coupons,
    assignable: allCoupons?.filter((coupon) => coupon.active),
  };
}
