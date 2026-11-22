'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  deletedTenantSchema,
  manualBillingSchema,
  manualEditSchema,
  type DeletedTenant,
  type ManualBilling,
  type SettableStatus,
} from '@/api/contracts/console';
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
  /** The member is gone (USER_NOT_FOUND, or the delete route's "User not found"). */
  | 'member_not_found'
  /** A SYSTEM_ADMIN is never edited or removed from a tenant. */
  | 'system_admin'
  /** Remove: the operator's own membership. */
  | 'self'
  | 'same_email'
  | 'email_taken'
  /** The login is shared with other organizations: invite the new address instead. */
  | 'identity_shared'
  /** Authentik refused or did not answer: nothing was changed. */
  | 'idp_failed'
  /** Authentik could not be read to confirm: nothing was changed; a retry is safe. */
  | 'idp_unknown'
  /** Remove: the tenant's only Owner. */
  | 'last_admin'
  /** Add: already a member (checked against the list first; the route's USER_EXISTS). */
  | 'already_member'
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
  /** Delete or a billing edit: Shopify bills it; Shopify owns its billing. */
  | 'shopify_billed'
  /** Billing edit: a payment is being collected (PAST_DUE, dunning). */
  | 'in_dunning'
  /** Billing edit: a grandfathered plan is not edited by hand. */
  | 'grandfathered'
  /** Billing edit: the subscription's state can't be edited (its status in `detail`). */
  | 'state_not_editable'
  /** Change plan: no live period to keep, so an end date is needed. */
  | 'end_date_required'
  /** An end date at or before now: it would end access at once. */
  | 'end_date_in_past'
  /** Set end date: the tenant has no plan. */
  | 'no_subscription'
  /** The plan or a volume can no longer be chosen. */
  | 'plan_unavailable'
  | 'volume_invalid'
  /** POC: a feature area is no longer offered. */
  | 'unknown_domain'
  /** Billing did not answer: nothing was changed. */
  | 'billing_unreachable'
  /** Member email: they sign in with Google only, and the change would leave no way in. */
  | 'no_other_sign_in'
  /** Anything else: NOT "nothing happened". The screen re-reads. */
  | 'failed';

export type EditResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: EditRefusal;
      /**
       * What a FAILED write still left behind - the member email's 502 with
       * `google_connection_removed` (Backend ff3a1b9f): the email is back, the
       * Google connection is gone.
       */
      readonly warnings?: readonly string[];
    };

async function refusalOf(
  cause: unknown,
  event: string,
  codes: Readonly<Record<string, EditRefusal>> = {},
  prose?: EditRefusal,
): Promise<{ readonly ok: false; readonly reason: EditRefusal }> {
  if (isApiError(cause)) {
    const known = cause.code ? (codes[cause.code] ?? COMMON[cause.code]) : prose;
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

/** The member routes' codes; the delete route's older refusals are prose, matched exactly. */
const MEMBER: Readonly<Record<string, EditRefusal>> = {
  USER_NOT_FOUND: 'member_not_found',
  SYSTEM_ADMIN: 'system_admin',
  SAME_EMAIL: 'same_email',
  EMAIL_TAKEN: 'email_taken',
  IDENTITY_SHARED: 'identity_shared',
  IDP_SYNC_FAILED: 'idp_failed',
  IDP_STATE_UNKNOWN: 'idp_unknown',
  NO_OTHER_SIGN_IN: 'no_other_sign_in',
  LAST_ADMIN: 'last_admin',
  /** Add: already a member, case-insensitive, or the same person under another email. */
  USER_EXISTS: 'already_member',
};
const MEMBER_PROSE: Readonly<Record<string, EditRefusal>> = {
  'User not found': 'member_not_found',
  'Tenant not found': 'not_found',
  'Cannot delete a system admin user': 'system_admin',
  'You cannot delete your own account': 'self',
};
const memberRefusal = (cause: unknown, event: string) =>
  refusalOf(
    cause,
    event,
    MEMBER,
    // Read only when the route sent no code: refusalOf prefers the code.
    isApiError(cause) && cause.developerMessage ? MEMBER_PROSE[cause.developerMessage] : undefined,
  );

const anything = z.unknown();

/**
 * Set a tenant's status by hand, without waiting for payment or onboarding.
 * The status alone may not open the product: the gate also reads the plan,
 * and the route says so in `warnings` (no_access_source).
 */
export async function setTenantStatus(
  tenantId: string,
  status: SettableStatus,
  reason: string,
): Promise<EditResult> {
  try {
    const result = await serverApi().patch({
      endpoint: consoleEndpoints.tenantStatus(tenantId),
      body: { status, reason: reason.trim() },
      payload: manualEditSchema,
    });
    return { ok: true, warnings: result.warnings };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.tenant_status_failed');
  }
}

/**
 * Change a member's login email, in Authentik and here. The password and open
 * sessions are left as they are. Refused when the login is shared with other
 * organizations: the screen offers inviting the new address instead.
 */
export async function changeMemberEmail(
  tenantId: string,
  userId: string,
  newEmail: string,
  reason: string,
): Promise<EditResult> {
  try {
    const result = await serverApi().patch({
      endpoint: consoleEndpoints.memberEmail(tenantId),
      body: { userId, newEmail: newEmail.trim(), reason: reason.trim() },
      payload: manualEditSchema,
    });
    return { ok: true, warnings: result.warnings };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const refused = await memberRefusal(cause, 'console.member_email_failed');
    const left = isApiError(cause)
      ? (cause.issues?.warnings ?? []).filter((w): w is string => typeof w === 'string')
      : [];
    return left.length > 0 ? { ...refused, warnings: left } : refused;
  }
}

/** Add a member: invited by the existing flow, which emails the setup link. */
export async function addMember(
  tenantId: string,
  member: { readonly email: string; readonly name: string; readonly role: 'ADMIN' | 'AGENT' },
  reason: string,
): Promise<EditResult> {
  try {
    await serverApi().post({
      endpoint: consoleEndpoints.members(tenantId),
      body: {
        email: member.email.trim(),
        name: member.name.trim(),
        role: member.role,
        reason: reason.trim(),
      },
      // `{ data, setupLink }`: the link is never shown here; the invite emails it.
      payload: anything,
      raw: true,
    });
    return { ok: true, warnings: [] };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return memberRefusal(cause, 'console.member_add_failed');
  }
}

/** Remove a member: the login is revoked first, then the membership goes. */
export async function removeMember(
  tenantId: string,
  userId: string,
  reason: string,
): Promise<EditResult> {
  try {
    await serverApi().delete({
      endpoint: consoleEndpoints.member(tenantId, userId),
      body: { reason: reason.trim() },
      payload: anything,
    });
    return { ok: true, warnings: [] };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return memberRefusal(cause, 'console.member_remove_failed');
  }
}

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

const BILLING: Readonly<Record<string, EditRefusal>> = {
  SHOPIFY_BILLED: 'shopify_billed',
  IN_DUNNING: 'in_dunning',
  GRANDFATHERED: 'grandfathered',
  SUBSCRIPTION_STATE_NOT_EDITABLE: 'state_not_editable',
  END_DATE_REQUIRED: 'end_date_required',
  END_DATE_IN_PAST: 'end_date_in_past',
  NO_SUBSCRIPTION: 'no_subscription',
  PLAN_VERSION_NOT_FOUND: 'plan_unavailable',
  PLAN_VERSION_NOT_ACTIVE: 'plan_unavailable',
  PLAN_VERSION_NOT_SELECTABLE: 'plan_unavailable',
  PLAN_VERSION_NOT_PUBLIC: 'plan_unavailable',
  PLAN_VERSION_BELONGS_TO_ANOTHER_ORGANIZATION: 'plan_unavailable',
  BILLING_INTERVAL_MISMATCH: 'plan_unavailable',
  EXPIRY_MUST_BE_IN_THE_FUTURE: 'end_date_in_past',
  VOLUME_OPTION_NOT_ENABLED: 'volume_invalid',
  VOLUME_OPTION_INVALID: 'volume_invalid',
  UNKNOWN_FEATURE_DOMAIN: 'unknown_domain',
  UNITS_MUST_BE_POSITIVE: 'invalid',
  CREDIT_BUDGET_REQUIRED: 'invalid',
  BILLING_UNREACHABLE: 'billing_unreachable',
};

/** One manual billing edit, as the route takes it (`billingManualSchema`). */
export type ManualBillingEdit =
  | {
      readonly action: 'change_plan';
      readonly planVersionId: string;
      readonly chatVolumeOptionKey: string | null;
      readonly voiceVolumeOptionKey: string | null;
      /** ISO instant; absent keeps a live period's end. */
      readonly endsAt?: string;
    }
  | { readonly action: 'set_end_date'; readonly endsAt: string }
  | {
      readonly action: 'switch_to_poc';
      readonly pocCredits: number;
      readonly pocExpiresAt: string;
      readonly pocFeatureAreas: readonly string[];
    }
  | { readonly action: 'add_credits'; readonly units: number };

export type ManualBillingResult =
  ({ readonly ok: true } & ManualBilling) | { readonly ok: false; readonly reason: EditRefusal };

/**
 * Change a tenant's plan, its end date, switch it to a POC, or add credits,
 * by hand. NEVER A CHARGE: billing applies it with `charges: "none"`, calls no
 * payment provider, and turns renewal off after every plan or date edit (the
 * tenant is not charged or renewed automatically; access ends on the period's
 * end). Refused for a Shopify-billed tenant, one in dunning, or a past date.
 *
 * Not behind BILLING_WRITES: that gate holds writes that move money through
 * the live payment account, and this one moves none.
 */
export async function manualBillingEdit(
  tenantId: string,
  edit: ManualBillingEdit,
  reason: string,
): Promise<ManualBillingResult> {
  try {
    const result = await serverApi().post({
      endpoint: consoleEndpoints.manualBilling(tenantId),
      body: { ...edit, reason: reason.trim() },
      payload: manualBillingSchema,
    });
    return { ok: true, ...result };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'console.manual_billing_failed', BILLING);
  }
}
