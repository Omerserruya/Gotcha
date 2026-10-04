'use server';

import { z } from 'zod';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { grantSchema } from '@/api/contracts/roles';
import { permissionEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Overrides on one person — screen 12e.
 *
 * ── TWO FUNCTIONS, NOT ONE WITH A FLAG ──
 * `PUT /users/:userId/grants/:feature` takes `{ granted, reason }`, so a
 * single call could do both. It is split here because **adding and removing
 * are not two directions of one action — they are two actions with opposite
 * visibility.**
 *
 * An addition is self-evidencing: someone has a capability their role does
 * not give, and it shows the moment they use it. **A removal is invisible
 * everywhere except the person panel.** The role says they can refund, they
 * are listed under that role, and they cannot refund — and nothing they or
 * anyone else looks at will explain why.
 *
 * A shared function with a boolean makes them look symmetrical at every call
 * site, and **a control one click from its opposite will eventually be
 * clicked by someone who meant the other** — silently, for exactly the case
 * that is already silent.
 */

export type GrantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' | 'gone' | 'needs_reason' | 'failed' };

/** Gives someone a permission their role does not include. */
export async function addPermission(
  userId: string,
  feature: string,
  reason: string,
): Promise<GrantResult> {
  return write(userId, feature, true, reason);
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
  return write(userId, feature, false, reason);
}

async function write(
  userId: string,
  feature: string,
  granted: boolean,
  reason: string,
): Promise<GrantResult> {
  try {
    await serverApi().put({
      endpoint: permissionEndpoints.userGrant(userId, feature),
      payload: grantSchema,
      body: { granted, reason: reason.trim() || null },
    });
    revalidatePath('/[locale]/(app)/settings/people', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'gone' };
    }
    logger.warn('grants.write_failed', { cause, granted });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Create a role — screen 12c.
 *
 * The design: *"You start from an existing role and only touch what's
 * different."* That is not a server concept — `POST /permissions/roles` takes
 * `{ name, description, features }` and knows nothing about a source. Starting
 * from a role means seeding the selection from its features and sending the
 * result, which is one call rather than a copy plus an edit.
 *
 * Two refusals worth distinguishing, because they need different actions:
 * **409** is a name already in use, and **400** names the unknown features it
 * rejected — a feature key the catalogue offered but the server does not
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
    };

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
    if (isApiError(cause)) {
      if (cause.status === 409) return { ok: false, reason: 'name_taken' };
      if (cause.status === 400) return { ok: false, reason: 'unknown_features' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
