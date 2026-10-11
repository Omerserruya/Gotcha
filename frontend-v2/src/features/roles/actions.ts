'use server';

import { z } from 'zod';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { grantSchema } from '@/api/contracts/roles';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

import { ceilingRefusalOf, type CeilingRefusal } from './ceiling';

/**
 * Overrides on one person - screen 12e.
 *
 * ── TWO FUNCTIONS, NOT ONE WITH A FLAG ──
 * `PUT /users/:userId/grants/:feature` takes `{ granted, reason }`, so a
 * single call could do both. It is split here because **adding and removing
 * are not two directions of one action - they are two actions with opposite
 * visibility.**
 *
 * An addition is self-evidencing: someone has a capability their role does
 * not give, and it shows the moment they use it. **A removal is invisible
 * everywhere except the person panel.** The role says they can refund, they
 * are listed under that role, and they cannot refund - and nothing they or
 * anyone else looks at will explain why.
 *
 * A shared function with a boolean makes them look symmetrical at every call
 * site, and **a control one click from its opposite will eventually be
 * clicked by someone who meant the other** - silently, for exactly the case
 * that is already silent.
 */

export type GrantResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'forbidden' | 'gone' | 'needs_reason' | 'past_date' | 'failed';
    }
  /** Granting what the caller lacks, or touching an Owner's access (`ceiling.ts`). */
  | CeilingRefusal;

/** Gives someone a permission their role does not include. */
export async function addPermission(
  userId: string,
  feature: string,
  reason: string,
  /** ISO; `null` = no end date. */
  expiresAt: string | null = null,
): Promise<GrantResult> {
  return write(userId, feature, true, reason, expiresAt);
}

/**
 * Takes away a permission the person's role **does** include.
 *
 * `reason` is **required here even though the endpoint accepts it as
 * optional**. An unexplained addition is a puzzle; an unexplained removal is
 * a person who cannot do their job and nobody who can say why.
 */
export async function removePermission(
  userId: string,
  feature: string,
  reason: string,
): Promise<GrantResult> {
  if (reason.trim().length === 0) return { ok: false, reason: 'needs_reason' };
  return write(userId, feature, false, reason, null);
}

async function write(
  userId: string,
  feature: string,
  granted: boolean,
  reason: string,
  /*
   * Always sent: the PUT REPLACES the override, so leaving it out would clear
   * a date that was there (backend 53a5079a).
   */
  expiresAt: string | null,
): Promise<GrantResult> {
  try {
    await serverApi().put({
      endpoint: permissionEndpoints.userGrant(userId, feature),
      payload: grantSchema,
      body: { granted, reason: reason.trim() || null, expiresAt },
    });
    revalidatePath('/[locale]/(app)/settings/people', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // Before the bare 403: these are 403s too, and each has its own sentence.
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 422) return { ok: false, reason: 'past_date' };
    }
    logger.warn('grants.write_failed', { cause, granted });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Create a role - screen 12c.
 *
 * The design: *"You start from an existing role and only touch what's
 * different."* That is not a server concept - `POST /permissions/roles` takes
 * `{ name, description, features }` and knows nothing about a source. Starting
 * from a role means seeding the selection from its features and sending the
 * result, which is one call rather than a copy plus an edit.
 *
 * Two refusals worth distinguishing, because they need different actions:
 * **409** is a name already in use, and **400** names the unknown features it
 * rejected - a feature key the catalogue offered but the server does not
 * grant, which is a drift between the two and not something the person typed.
 */
export type CreateRoleResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      /**
       * `name_taken` is a 409 and the person can fix it by typing something
       * else. `unknown_features` is a 400 and they cannot: it means the
       * catalogue offered a key the server will not grant, which is drift
       * between two lists and nothing the person did.
       */
      readonly reason: 'name_taken' | 'unknown_features' | 'forbidden' | 'failed';
    }
  /** A role holding what its creator lacks ("*" included) - nothing created. */
  | CeilingRefusal;

export async function createRole(input: {
  name: string;
  description: string;
  features: readonly string[];
}): Promise<CreateRoleResult> {
  try {
    const data = await serverApi().post({
      endpoint: permissionEndpoints.roles(),
      payload: z.object({ data: z.object({ id: z.string() }) }).transform((r) => r.data),
      body: input,
      raw: true,
    });
    revalidatePath('/[locale]/settings/people/roles', 'page');
    return { ok: true, id: data.id };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('roles.create_failed', { cause });
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.status === 409) return { ok: false, reason: 'name_taken' };
      if (cause.status === 400) return { ok: false, reason: 'unknown_features' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type UpdateRoleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `system` - a built-in role (the route refuses to change it);
       * `unknown_features` - the catalogue offered a key the server will not
       * grant; `partial` - the capabilities were saved and the name or
       * description was not; `gone` - the role is no longer there.
       */
      readonly reason:
        'system' | 'unknown_features' | 'partial' | 'name_taken' | 'gone' | 'forbidden' | 'failed';
    }
  /** The features PUT refused them: nothing was changed. */
  | CeilingRefusal;

/**
 * Edit a custom role - 12b's Edit: its capabilities (`PUT …/features`,
 * replacing them), then its name and description (`PATCH`). Two routes, in
 * that order: the features are what the route validates, so a refusal there
 * changes nothing; a failure after them is said as partly saved, never as
 * done.
 *
 * ⚠ A built-in role is never sent. Both routes refuse it (403 SYSTEM_ROLE,
 *   the features route since auth 00d669a3), and that refusal is still said
 *   as `system` should a stale screen send one.
 * ★ A taken name is 409 ROLE_NAME_TAKEN on the PATCH - after the capabilities
 *   were saved, so it says so.
 */
export async function updateRole(
  roleId: string,
  input: { name: string; description: string; features: readonly string[]; isSystem: boolean },
): Promise<UpdateRoleResult> {
  if (input.isSystem) return { ok: false, reason: 'system' };
  try {
    await serverApi().put({
      endpoint: permissionEndpoints.roleFeatures(roleId),
      body: { features: input.features },
      payload: z.unknown(),
      raw: true,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('roles.update_features_failed', { cause });
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'unknown_features' };
      // 00d669a3: the features route refuses a built-in role by code too.
      if (cause.code === 'SYSTEM_ROLE') return { ok: false, reason: 'system' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    return { ok: false, reason: 'failed' };
  }
  try {
    await serverApi().patch({
      endpoint: permissionEndpoints.role(roleId),
      body: { name: input.name, description: input.description || null },
      payload: z.unknown(),
      raw: true,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('roles.update_name_failed', { cause });
    revalidatePath('/[locale]/settings/people/roles', 'page');
    if (isApiError(cause)) {
      if (cause.code === 'SYSTEM_ROLE' || cause.status === 403)
        return { ok: false, reason: 'system' };
      // The capabilities are saved by now; only the name was refused.
      if (cause.code === 'ROLE_NAME_TAKEN' || cause.status === 409)
        return { ok: false, reason: 'name_taken' };
    }
    return { ok: false, reason: 'partial' };
  }
  revalidatePath('/[locale]/settings/people/roles', 'page');
  return { ok: true };
}

export type ChangeRoleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `self_lockout` - the caller would take away their own admin (409
       * SELF_LOCKOUT); `last_admin` - the workspace would be left without one
       * (409 LAST_ADMIN). Both are the server's, checked under a workspace
       * lock (auth 00d669a3) - the screen does not pre-judge them, it says
       * them. `gone` - the person or the role is no longer there.
       */
      readonly reason: 'self_lockout' | 'last_admin' | 'gone' | 'forbidden' | 'failed';
    }
  /** A role above the caller's own, or an Owner's role changed by a non-owner. */
  | CeilingRefusal;

const ASSIGNMENT_SCOPES = ['OWN', 'TEAM', 'DEPARTMENT', 'WORKSPACE'] as const;

/**
 * 12d's Change - a person's role, REPLACED (`PUT /users/:id/role`): every
 * assignment they hold is removed and this one made, so the screen never
 * shows a role they do not solely hold (the supervisor's call, 2026-10-08).
 * The scope they hold is kept - only the role changes; one the route does not
 * know is sent as none.
 *
 * Other services cache a person's role for up to 30 seconds, so success is
 * said as "takes effect within a minute", never as done everywhere.
 */
export async function changeRole(
  userId: string,
  roleId: string,
  scope: string | null,
): Promise<ChangeRoleResult> {
  const kept = (ASSIGNMENT_SCOPES as readonly string[]).includes(scope?.toUpperCase() ?? '')
    ? scope!.toUpperCase()
    : null;
  try {
    await serverApi().put({
      endpoint: permissionEndpoints.userRole(userId),
      body: { roleId, scope: kept },
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/settings/people', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('roles.change_failed', { status: isApiError(cause) ? cause.status : undefined });
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.code === 'SELF_LOCKOUT') return { ok: false, reason: 'self_lockout' };
      if (cause.code === 'LAST_ADMIN') return { ok: false, reason: 'last_admin' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
