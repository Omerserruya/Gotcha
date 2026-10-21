import type { ProvisioningStatus } from '@/api/contracts/console';

/**
 * Which operator problem a tenant has (legacy `tenantBillingUiState`,
 * `TenantBilling.tsx`).
 *
 * The distinction that matters: a tenant awaiting the CUSTOMER needs the
 * payment link resent; one whose billing setup never finished needs a repair
 * - resending a link that does not exist helps nobody. Only the provisioning
 * request tells them apart, so no request at all is "incomplete", never
 * assumed ready.
 *
 * One state legacy did not have: `BILLING_UNREAD`. Legacy turned a failed
 * read of the request into `null` and so into "setup incomplete" - offering
 * a repair on the strength of a network error. A failed read is its own
 * answer (`undefined` here; `null` is the route's "no request").
 */
export type TenantBillingState =
  'ACTIVE' | 'PENDING_PAYMENT_READY' | 'BILLING_SETUP_INCOMPLETE' | 'BILLING_UNREAD' | 'OTHER';

export function tenantBillingState(
  tenantStatus: string,
  provisioning: ProvisioningStatus | undefined,
): TenantBillingState {
  if (tenantStatus === 'ACTIVE') return 'ACTIVE';
  if (tenantStatus !== 'PENDING_PAYMENT') return 'OTHER';
  if (provisioning === undefined) return 'BILLING_UNREAD';
  if (provisioning?.state === 'COMPLETED') return 'PENDING_PAYMENT_READY';
  return 'BILLING_SETUP_INCOMPLETE';
}
