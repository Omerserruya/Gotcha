'use server';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  createdTenantSchema,
  provisioningQuoteSchema,
  type ProvisioningQuote,
} from '@/api/contracts/console';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** A paid selection: KEYS only - no price, credits or currency (the route refuses any). */
export interface PaidSelection {
  readonly planVersionId: string;
  readonly chatVolumeOptionKey: string | null;
  readonly voiceVolumeOptionKey: string | null;
}

/**
 * The server's quote for a selection (admin-pricing.ts:1125). A read in POST
 * form: it prices, it writes nothing. Its refusal codes say which part of
 * the selection is no longer valid.
 */
export async function quoteProvisioning(
  selection: PaidSelection,
): Promise<
  | { readonly ok: true; readonly quote: ProvisioningQuote }
  | { readonly ok: false; readonly reason: 'plan_gone' | 'volume_invalid' | 'failed' }
> {
  try {
    const quote = await serverApi().post({
      endpoint: consoleEndpoints.quote(),
      body: selection,
      payload: provisioningQuoteSchema,
    });
    return { ok: true, quote };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const code = isApiError(cause) ? cause.developerMessage : undefined;
    if (code === 'plan_version_not_active' || code === 'plan_version_not_found') {
      return { ok: false, reason: 'plan_gone' };
    }
    if (code === 'volume_option_invalid' || code === 'volume_option_not_enabled') {
      return { ok: false, reason: 'volume_invalid' };
    }
    logger.warn('console.quote_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

export type NewTenantBilling =
  | ({ readonly mode: 'PAID_PLAN'; readonly commercialNote?: string } & PaidSelection)
  | {
      readonly mode: 'POC';
      readonly pocCredits: number;
      /** ISO instant - the END of the chosen day. */
      readonly pocExpiresAt: string;
      readonly pocFeatureAreas: readonly string[];
      readonly commercialNote?: string;
    };

export interface NewTenant {
  readonly name: string;
  readonly slug: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly billing: NewTenantBilling;
}

export type CreateTenantResult =
  | { readonly ok: true; readonly tenantId: string }
  /**
   * 502: the tenant WAS created and its billing setup did not complete. Not
   * a failure to create - "repair it on its page, never create it again".
   */
  | { readonly ok: false; readonly reason: 'setup_incomplete'; readonly tenantId: string | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'held'
        | 'slug_taken'
        | 'invalid'
        | 'expiry_past'
        | 'unknown_domain'
        | 'invalid_billing'
        | 'forbidden'
        | 'failed';
    };

/**
 * Create an organization with its admin and its commercial decision
 * (system.ts:348): a PAID plan (pending payment, its admin emailed a setup
 * link and a payment link) or a POC (credits given away, no charge, no
 * renewal). A paid one provisions a real checkout, so it is HELD unless
 * `BILLING_WRITES=on`; a POC moves no money.
 */
export async function createTenant(input: NewTenant): Promise<CreateTenantResult> {
  if (input.billing.mode === 'PAID_PLAN' && !billingWritesEnabled()) {
    return { ok: false, reason: 'held' };
  }
  try {
    const created = await serverApi().post({
      endpoint: consoleEndpoints.tenants(),
      body: input,
      payload: createdTenantSchema.catch({ tenant: { id: '', name: '' } }),
    });
    return { ok: true, tenantId: created.tenant.id };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 502) {
        const tenant = cause.errorData?.tenant as { id?: unknown } | undefined;
        return {
          ok: false,
          reason: 'setup_incomplete',
          tenantId: typeof tenant?.id === 'string' ? tenant.id : null,
        };
      }
      if (cause.kind === 'conflict') return { ok: false, reason: 'slug_taken' };
      if (cause.developerMessage === 'Invalid billing selection') {
        if (cause.code === 'expiry_must_be_in_the_future')
          return { ok: false, reason: 'expiry_past' };
        if (cause.code === 'unknown_feature_domain') return { ok: false, reason: 'unknown_domain' };
        return { ok: false, reason: 'invalid_billing' };
      }
      if (cause.kind === 'validation') return { ok: false, reason: 'invalid' };
      if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    }
    logger.warn('console.create_tenant_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
