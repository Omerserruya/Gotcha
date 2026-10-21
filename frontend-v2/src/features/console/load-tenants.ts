import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  provisioningStatusSchema,
  tenantListSchema,
  type ProvisioningStatus,
  type TenantRow,
} from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** The route's own page size (system.ts:105); asked for explicitly so the screen can say it. */
export const TENANT_PAGE_SIZE = 50;

export type TenantList =
  | {
      readonly ok: true;
      readonly tenants: readonly TenantRow[];
      /** Every tenant the search matches; more than `tenants` when the page is full. */
      readonly total: number;
      /**
       * Per PENDING_PAYMENT tenant: its provisioning request, `null` when it
       * has none, absent when the read failed (`tenantBillingState`).
       */
      readonly provisioning: Readonly<Record<string, ProvisioningStatus>>;
    }
  | { readonly ok: false };

/**
 * `/system/tenants` - legacy `system/tenants/page.tsx`.
 *
 * The list, then one provisioning read per tenant awaiting payment - only
 * those need it, and only their own request decides between Resend and
 * Repair. A failed provisioning read leaves that tenant out of the map
 * rather than writing `null`, which would mean "no request".
 */
export async function loadTenants(search: string): Promise<TenantList> {
  const api = serverApi();
  let list;
  try {
    list = await api.get({
      endpoint: consoleEndpoints.tenants(),
      query: { search: search || undefined, limit: TENANT_PAGE_SIZE },
      payload: tenantListSchema,
      raw: true,
    });
  } catch (cause) {
    logger.warn('console.tenants_failed', { cause });
    return { ok: false };
  }

  const pending = list.data.filter((tenant) => tenant.status === 'PENDING_PAYMENT');
  const reads = await Promise.all(
    pending.map(async (tenant) => {
      try {
        const status = await api.get({
          endpoint: consoleEndpoints.provisioning(tenant.id),
          payload: provisioningStatusSchema,
        });
        return [tenant.id, status] as const;
      } catch (cause) {
        logger.warn('console.provisioning_failed', { cause });
        return null;
      }
    }),
  );

  return {
    ok: true,
    tenants: list.data,
    total: list.meta?.total ?? list.data.length,
    provisioning: Object.fromEntries(reads.filter((read) => read !== null)),
  };
}
