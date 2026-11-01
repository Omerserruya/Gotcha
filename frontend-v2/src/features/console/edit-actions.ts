'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { deletedTenantSchema, type DeletedTenant } from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The console's manual edits on one tenant (Backend's contract, 2026-10-23):
 * things a SYSTEM_ADMIN sets by hand, each with a reason the route records.
 * Mocked in every test.
 *
 * ★ READ BY `code`, NEVER BY `kind`. Every refusal here is `{ error, code }`
 *   with an UPPER_SNAKE code, and the transport files any `TENANT_*` code as
 *   `tenant_inactive` (the caller's organization gated): TENANT_NOT_FOUND
 *   would read as that, not as "no such tenant". A 400 without a code is the
 *   shared validator, `details[].field` naming the field.
 */
export type EditRefusal =
  | 'not_found'
  /** The validator refused the reason (blank after trim, or too long). */
  | 'reason_invalid'
  /** The validator refused another field. */
  | 'invalid'
  | 'forbidden'
  /** Delete: the slug typed does not match. */
  | 'slug_mismatch'
  /** Delete: the System tenant is never deleted. */
  | 'system_tenant'
  /** Delete: the tenant the operator is signed in to. */
  | 'own_tenant'
  /** Delete: a paid plan that can still charge (ACTIVE, PAST_DUE or a renewing trial). */
  | 'paid_subscription'
  /** Delete: a checkout the customer could still complete. */
  | 'open_checkout'
  /** Delete: Shopify bills it; Shopify owns its billing. */
  | 'shopify_billed'
  /** Anything else: NOT "nothing happened". The screen re-reads. */
  | 'failed';

async function refusalOf(
  cause: unknown,
  event: string,
  codes: Readonly<Record<string, EditRefusal>> = {},
): Promise<{ readonly ok: false; readonly reason: EditRefusal }> {
  if (isApiError(cause)) {
    const known = cause.code ? (codes[cause.code] ?? COMMON[cause.code]) : undefined;
    if (known) return { ok: false, reason: known };
    if (cause.status === 400 && !cause.code && cause.fieldErrors?.length) {
      return {
        ok: false,
        reason: cause.fieldErrors.some((each) => each.field === 'reason')
          ? 'reason_invalid'
          : 'invalid',
      };
    }
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
  }
  logger.warn(event, { cause });
  return { ok: false, reason: 'failed' };
}
const COMMON: Readonly<Record<string, EditRefusal>> = { TENANT_NOT_FOUND: 'not_found' };


export type DeleteResult =
  | { readonly ok: true; readonly deleted: DeletedTenant }
  | { readonly ok: false; readonly reason: EditRefusal };

const DELETE: Readonly<Record<string, EditRefusal>> = {
  CONFIRM_SLUG_MISMATCH: 'slug_mismatch',
  SYSTEM_TENANT: 'system_tenant',
  OWN_TENANT: 'own_tenant',
  ACTIVE_PAID_SUBSCRIPTION: 'paid_subscription',
  OPEN_CHECKOUT: 'open_checkout',
  SHOPIFY_BILLED: 'shopify_billed',
};

/**
 * Delete a tenant permanently, now: every row, its files, its logins that
 * belong nowhere else. The route never charges, refunds or disconnects
 * anything on a provider's side; what is left there comes back to be said.
 * The slug is the one the operator TYPED - the route compares it.
 */
export async function deleteTenant(
  tenantId: string,
  confirmSlug: string,
  reason: string,
): Promise<DeleteResult> {
  try {
    const deleted = await serverApi().delete({
      endpoint: consoleEndpoints.tenant(tenantId),
      body: { confirmSlug, reason: reason.trim() },
      payload: deletedTenantSchema,
    });
    return { ok: true, deleted };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.tenant_delete_failed', DELETE);
  }
}
