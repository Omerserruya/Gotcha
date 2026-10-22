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

/**
 * What a built-in role's own rules refused (auth 30d610da) - each said in a
 * sentence (`ceiling-words.ts` `roleRuleSentence`). Nothing was changed on any.
 *
 *   role_ceiling  403 ROLE_CEILING `{ blocked }` - keys this role can never hold.
 *   owner_floor   422 OWNER_FLOOR `{ missing }` - keys the Owner always keeps.
 *   role_merged   409 ROLE_MERGED - the Admin role, now part of Owner.
 */
export type RoleRuleRefusal =
  | { readonly ok: false; readonly reason: 'role_ceiling'; readonly blocked: readonly string[] }
  | { readonly ok: false; readonly reason: 'owner_floor'; readonly missing: readonly string[] }
  | { readonly ok: false; readonly reason: 'role_merged' };

/** The role-rule refusal in `cause`, or `null` when it is some other failure. */
function roleRuleRefusalOf(cause: unknown): RoleRuleRefusal | null {
  if (!isApiError(cause)) return null;
  if (cause.code === 'ROLE_CEILING')
    return { ok: false, reason: 'role_ceiling', blocked: [...(cause.blocked ?? [])] };
  if (cause.code === 'OWNER_FLOOR')
    return { ok: false, reason: 'owner_floor', missing: [...(cause.missing ?? [])] };
  if (cause.code === 'ROLE_MERGED') return { ok: false, reason: 'role_merged' };
  return null;
}

export type UpdateRoleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `system` - built-in roles can't be changed right now (403
       * SYSTEM_ROLE: the server's kill switch is on); `unknown_features` -
       * the catalogue offered a key the server will not grant; `partial` -
       * the capabilities were saved and the name or description was not;
       * `gone` - the role is no longer there.
       */
      readonly reason:
        'system' | 'unknown_features' | 'partial' | 'name_taken' | 'gone' | 'forbidden' | 'failed';
    }
  /** The features PUT refused them: nothing was changed. */
  | CeilingRefusal
  | RoleRuleRefusal;

/**
 * Edit a role - 12b's Edit: its capabilities (`PUT …/features`, replacing
 * them), then, for a custom role, its name and description (`PATCH`). Two
 * routes, in that order: the features are what the route validates, so a
 * refusal there changes nothing; a failure after them is said as partly
 * saved, never as done.
 *
 * ★ A BUILT-IN role (auth 30d610da) sends its capabilities only. PATCH still
 *   refuses it (403 SYSTEM_ROLE) - it keeps its name and description - so the
 *   rename is never sent, and a built-in's save is one call.
 * ★ The PUT's own refusals for a built-in - its ceiling, the Owner's floor,
 *   the merged Admin - each come back as their own reason, before the bare
 *   403s they share a status with.
 * ★ A taken name is 409 ROLE_NAME_TAKEN on the PATCH - after the capabilities
 *   were saved, so it says so.
 */
export async function updateRole(
  roleId: string,
  input: { name: string; description: string; features: readonly string[]; isSystem: boolean },
): Promise<UpdateRoleResult> {
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
    const rule = roleRuleRefusalOf(cause);
    if (rule) return rule;
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'unknown_features' };
      // The kill switch (ROLES_EDITABLE=false): built-in roles are fixed again.
      if (cause.code === 'SYSTEM_ROLE') return { ok: false, reason: 'system' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    return { ok: false, reason: 'failed' };
  }
  if (input.isSystem) {
    // No revalidate (AU2): its tree would abort the screen's navigation after this; the screen navigates or refreshes.
    return { ok: true };
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
    if (isApiError(cause)) {
      if (cause.code === 'SYSTEM_ROLE' || cause.status === 403)
        return { ok: false, reason: 'system' };
      // The capabilities are saved by now; only the name was refused.
      if (cause.code === 'ROLE_NAME_TAKEN' || cause.status === 409)
        return { ok: false, reason: 'name_taken' };
    }
    return { ok: false, reason: 'partial' };
  }
  return { ok: true };
}

export type ResetRoleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `not_builtin` - 409 NOT_BUILTIN: only a built-in role has defaults. */
      readonly reason: 'not_builtin' | 'gone' | 'forbidden' | 'failed';
    }
  /** The defaults hold something the caller does not (`patternsRefusal`). */
  | CeilingRefusal;

/**
 * "Reset to default" - a built-in role's permissions back to the product's
 * (`POST …/roles/:id/reset`, auth 30d610da). The role is no longer
 * customized afterwards, so the startup seed follows the catalogue for it
 * again. Asked first on the screen; nothing is changed on any refusal.
 */
export async function resetRole(roleId: string): Promise<ResetRoleResult> {
  try {
    await serverApi().post({
      endpoint: permissionEndpoints.roleReset(roleId),
      body: {},
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/settings/people/roles', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('roles.reset_failed', { cause });
    const ceiling = ceilingRefusalOf(cause);
    if (ceiling) return ceiling;
    if (isApiError(cause)) {
      if (cause.code === 'NOT_BUILTIN') return { ok: false, reason: 'not_builtin' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type ChangeRoleResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `self_lockout` - the caller would take away their own Owner role (409
       * SELF_LOCKOUT); `last_admin` - the workspace would be left without an
       * Owner (409 LAST_ADMIN: the code kept its name when Admin became part
       * of Owner, auth role-guard.ts). Both are the server's, checked under a workspace
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
