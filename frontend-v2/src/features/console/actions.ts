'use server';

import { z } from 'zod';

import { billingWritesEnabled } from '@/api/client/billing-writes';
import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The console's writes on one tenant (auth `routes/system.ts`). Every one has
 * a real effect: a billing provisioning run, an email to the customer, a
 * tenant that can no longer sign in. Mocked in every test.
 *
 * They return a result rather than throwing: the screen says each outcome in
 * words, and nothing is drawn as done until the route has said so. They
 * revalidate nothing - the screen refreshes (no-revalidate-before-navigation).
 *
 * ★ BILLING WRITES ARE HELD unless `BILLING_WRITES=on` (fail closed): dev's
 *   billing is the production payment account. Repair, resend payment link
 *   and assign a paid plan each provision or reuse a real checkout, so each
 *   refuses here, before any call, with `held`.
 *
 * The refusal codes are the routes' own `error` strings (`developerMessage`
 * here), several of them prose rather than codes - matched exactly.
 */
export type ConsoleRefusal =
  /** BILLING_WRITES is off: refused before any call, nothing was sent. */
  | 'held'
  | 'forbidden'
  | 'not_found'
  /** Repair: NO_PROVISIONING_REQUEST - nothing was ever requested to repair. */
  | 'no_request'
  /** TENANT_NOT_PENDING_PAYMENT, or resend's "Tenant is not awaiting payment". */
  | 'not_pending_payment'
  /** BILLING_PROVISIONING_ALREADY_COMPLETE: resend is the action, not repair. */
  | 'already_complete'
  /** 502 BILLING_PROVISIONING_FAILED: billing refused or did not answer. */
  | 'provisioning_failed'
  /** Resend: BILLING_PROVISIONING_INCOMPLETE - there is no link to resend. */
  | 'setup_incomplete'
  /** PAYMENT_LINK_RATE_LIMITED, with the route's wait. */
  | 'rate_limited'
  /** PAYMENT_LINK_NOT_AVAILABLE: the checkout cannot be resumed. */
  | 'link_not_available'
  /** link_issued_but_email_failed: a new link exists, the old one is revoked, no email. */
  | 'email_failed'
  /** No administrator to send to. */
  | 'no_admin'
  /** TENANT_ALREADY_HAS_A_PLAN. */
  | 'already_has_plan'
  /** "Invalid billing selection": the plan is no longer offered. */
  | 'invalid_plan'
  /** Resend onboarding: TENANT_AWAITING_PAYMENT - the onboarding door would skip paying. */
  | 'awaiting_payment'
  /** Resend onboarding: the tenant is ACTIVE already. */
  | 'already_onboarded'
  /**
   * Anything else - including a 200 this build could not read. NOT "nothing
   * happened": the screen says it could not confirm, and re-reads.
   */
  | 'failed';

export type ConsoleWrite<T extends object = object> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: ConsoleRefusal;
      readonly retryAfterSeconds?: number | null;
    };

const BY_ERROR: Readonly<Record<string, ConsoleRefusal>> = {
  NO_PROVISIONING_REQUEST: 'no_request',
  TENANT_NOT_PENDING_PAYMENT: 'not_pending_payment',
  'Tenant is not awaiting payment': 'not_pending_payment',
  BILLING_PROVISIONING_ALREADY_COMPLETE: 'already_complete',
  BILLING_PROVISIONING_FAILED: 'provisioning_failed',
  BILLING_PROVISIONING_INCOMPLETE: 'setup_incomplete',
  PAYMENT_LINK_RATE_LIMITED: 'rate_limited',
  PAYMENT_LINK_NOT_AVAILABLE: 'link_not_available',
  link_issued_but_email_failed: 'email_failed',
  'Tenant has no administrator to send to': 'no_admin',
  'No active admin user found for this tenant': 'no_admin',
  TENANT_ALREADY_HAS_A_PLAN: 'already_has_plan',
  'Invalid billing selection': 'invalid_plan',
  TENANT_AWAITING_PAYMENT: 'awaiting_payment',
  'Tenant has already completed onboarding': 'already_onboarded',
};

/** After `signInIfSignedOut` in the catch: a 401 never reaches here. */
async function refusalOf(cause: unknown, event: string): Promise<ConsoleWrite & { ok: false }> {
  if (isApiError(cause)) {
    const known = cause.developerMessage ? BY_ERROR[cause.developerMessage] : undefined;
    if (known === 'rate_limited') {
      return { ok: false, reason: known, retryAfterSeconds: cause.retryAfterSeconds ?? null };
    }
    if (known) return { ok: false, reason: known };
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    if (cause.kind === 'not_found') return { ok: false, reason: 'not_found' };
  }
  logger.warn(event, { cause });
  return { ok: false, reason: 'failed' };
}

/* Success bodies, read leniently: a 200 is a 200, and a field this build
   cannot read must not turn a done write into "failed". */
const emailOutcome = z.object({
  billing: z
    .object({ emailSent: z.boolean().nullable().catch(null).default(null) })
    .catch({ emailSent: null })
    .default({ emailSent: null }),
});
const sentTo = z.object({ sentTo: z.string().catch('').default('') });
const anything = z.unknown();

/**
 * Finish billing setup that never completed (system.ts:757). Creates the
 * checkout that was never made and emails the payment link; charges nothing.
 */
export async function repairBilling(
  tenantId: string,
): Promise<ConsoleWrite<{ readonly emailSent: boolean | null }>> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const result = await serverApi().post({
      endpoint: consoleEndpoints.repairBilling(tenantId),
      payload: emailOutcome,
    });
    return { ok: true, emailSent: result.billing.emailSent };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.repair_failed');
  }
}

/**
 * A new payment link for the SAME checkout (system.ts:1060); the old link
 * stops working. Emails the tenant's first admin.
 */
export async function resendPaymentLink(
  tenantId: string,
): Promise<ConsoleWrite<{ readonly sentTo: string }>> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const result = await serverApi().post({
      endpoint: consoleEndpoints.resendPaymentLink(tenantId),
      payload: sentTo,
    });
    return { ok: true, sentTo: result.sentTo };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.resend_payment_failed');
  }
}

/**
 * Give a plan-less tenant a paid plan (system.ts:910): it moves to Pending
 * payment and its admin is emailed a payment link. Nothing is charged here.
 * Refused for a tenant that holds a plan. The plan's KEY only - the route
 * prices it, and rejects any other field (`.strict()`).
 */
export async function assignPaidPlan(
  tenantId: string,
  planVersionId: string,
): Promise<ConsoleWrite<{ readonly emailSent: boolean | null }>> {
  if (!billingWritesEnabled()) return { ok: false, reason: 'held' };
  try {
    const result = await serverApi().post({
      endpoint: consoleEndpoints.assignPaidPlan(tenantId),
      body: { planVersionId },
      payload: emailOutcome,
    });
    return { ok: true, emailSent: result.billing.emailSent };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.assign_plan_failed');
  }
}

/**
 * Enable or disable a tenant (system.ts:1372). A disabled tenant's people
 * cannot sign in. Not a billing write.
 */
export async function setTenantActive(tenantId: string, isActive: boolean): Promise<ConsoleWrite> {
  try {
    await serverApi().patch({
      endpoint: consoleEndpoints.tenant(tenantId),
      body: { isActive },
      payload: anything,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.tenant_active_failed');
  }
}

/** Rename a tenant (system.ts:1372). The slug never changes. */
export async function renameTenant(tenantId: string, name: string): Promise<ConsoleWrite> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: 'failed' };
  try {
    await serverApi().patch({
      endpoint: consoleEndpoints.tenant(tenantId),
      body: { name: trimmed },
      payload: anything,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.tenant_rename_failed');
  }
}

/**
 * Email the tenant's admin a fresh onboarding link (system.ts:1161). The
 * route refuses a tenant awaiting payment: that door would skip paying.
 */
export async function resendOnboarding(
  tenantId: string,
): Promise<ConsoleWrite<{ readonly sentTo: string }>> {
  try {
    const result = await serverApi().post({
      endpoint: consoleEndpoints.resendOnboarding(tenantId),
      payload: sentTo,
    });
    return { ok: true, sentTo: result.sentTo };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.resend_onboarding_failed');
  }
}
