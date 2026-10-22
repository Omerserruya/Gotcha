'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  departmentSchema,
  inviteResultSchema,
  type Department,
  type InviteResult,
} from '@/api/contracts/people';
import { departmentEndpoints, memberEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { ceilingRefusalOf, type CeilingRefusal } from '@/features/roles/ceiling';

/**
 * Writes for screen 12.
 *
 * Server actions rather than browser calls: both of these are writes, and
 * routing them through the server keeps the BFF's origin check and the session
 * cookie doing their jobs without the form knowing either exists.
 *
 * They return a result rather than throwing, because the interesting failures
 * are answers the form has to render - an address already in the tenant, a
 * plan out of seats - not exceptions to catch.
 */

export type PeopleWriteResult<T> =
  | { readonly ok: true; readonly data: T }
  /** Per-field, from the server. Rendered beside the field that failed. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly fields: Record<string, string> }
  /** Already a member, or a team by that name already exists. */
  | { readonly ok: false; readonly reason: 'duplicate' }
  /**
   * The plan is out of seats, or out of teams.
   *
   * Its own outcome, because it is the one failure here that is neither the
   * admin's mistake nor a fault - it is a limit, and "you have used them all"
   * is a different sentence from "that didn't work", with a different next
   * step.
   *
   * Deliberately carries no numbers. The backend sends `limit` and `current`
   * in the 402 body, but `readErrorBody` does not capture them, so quoting a
   * figure here would mean inventing one. The message says how to free a seat
   * instead, which is the actionable half.
   */
  | { readonly ok: false; readonly reason: 'limit' }
  | { readonly ok: false; readonly reason: 'forbidden' }
  /** The role is not one of this workspace's (400 UNKNOWN_ROLE) - nobody invited. */
  | { readonly ok: false; readonly reason: 'unknown_role' }
  /** A role above the inviter's own, or Owner by a non-owner - nobody invited. */
  | CeilingRefusal
  | { readonly ok: false; readonly reason: 'failed' };

function fieldErrorsOf(cause: unknown): Record<string, string> {
  if (!isApiError(cause)) return {};
  return Object.fromEntries(cause.fieldErrors.map((f) => [f.field, f.message]));
}

/**
 * One classifier for both writes, because they fail the same ways.
 *
 * The 402 needs care: the transport maps that status to `tenant_inactive`,
 * which is right almost everywhere - but `requireCapacity` also answers 402,
 * for a plan limit. The two are told apart by `code`, never by status, so a
 * tenant that has simply run out of seats is not reported as suspended.
 */
function classify(cause: unknown): Extract<PeopleWriteResult<never>, { ok: false }> {
  // 403s with their own sentences, before the bare 403 below.
  const ceiling = ceilingRefusalOf(cause);
  if (ceiling) return ceiling;
  if (isApiError(cause)) {
    if (cause.code === 'PLAN_LIMIT_REACHED') return { ok: false, reason: 'limit' };
    // A 400 too, so before `validation`: the role, not a field the person typed.
    if (cause.code === 'UNKNOWN_ROLE') return { ok: false, reason: 'unknown_role' };
    if (cause.kind === 'conflict') return { ok: false, reason: 'duplicate' };
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    if (cause.kind === 'validation') {
      return { ok: false, reason: 'invalid', fields: fieldErrorsOf(cause) };
    }
  }
  return { ok: false, reason: 'failed' };
}

/**
 * Invites someone, with their teams, in one call.
 *
 * `departmentIds` is part of the same write rather than a follow-up, and the
 * backend validates every id against the ACTIVE tenant - a foreign or unknown
 * id fails the whole invite instead of creating a member with partial
 * memberships. That property is worth preserving: ids arriving from client
 * state are never trusted as-is, so this action passes them straight through
 * and lets the server be the authority.
 *
 * `role` is a TenantRole id of this workspace (auth 679b8812, G5); absent,
 * the route invites as an agent. The route resolves it in this tenant and
 * refuses one above the inviter's own - before anyone is created or emailed,
 * so a refusal invites nobody.
 */
export async function inviteMember(input: {
  email: string;
  name: string;
  departmentIds: readonly string[];
  role?: string | null;
}): Promise<PeopleWriteResult<InviteResult>> {
  try {
    const data = await serverApi().post({
      endpoint: memberEndpoints.invite(),
      payload: inviteResultSchema,
      body: {
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        ...(input.departmentIds.length > 0 ? { departmentIds: [...input.departmentIds] } : {}),
        ...(input.role ? { role: input.role } : {}),
      },
    });
    revalidatePath('/[locale]/settings/people', 'page');
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    /*
     * The email is NOT logged. It identifies a person, the write already
     * failed, and knowing which address was rejected is not worth putting a
     * customer's contact detail into telemetry.
     */
    logger.warn('people.invite_failed', { cause });
    return classify(cause);
  }
}

/** Creates a team. `queueMode` defaults to CLAIM server-side; we do not send one. */
export async function createTeam(input: {
  name: string;
  description: string;
}): Promise<PeopleWriteResult<Department>> {
  try {
    const data = await serverApi().post({
      endpoint: departmentEndpoints.create(),
      payload: departmentSchema,
      body: {
        name: input.name.trim(),
        ...(input.description.trim() ? { description: input.description.trim() } : {}),
      },
    });
    revalidatePath('/[locale]/settings/people', 'page');
    return { ok: true, data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('people.create_team_failed', { cause });
    return classify(cause);
  }
}
