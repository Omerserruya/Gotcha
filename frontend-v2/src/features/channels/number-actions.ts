'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'forbidden' | 'failed' };

export type AddContactResult =
  | WriteResult
  /** The route's own check: a phone number with at least 6 digits. */
  | { readonly ok: false; readonly reason: 'invalid_number' }
  /** The WhatsApp number it was for is not one of this workspace's (any more). */
  | { readonly ok: false; readonly reason: 'number_gone' };

function reasonOf(cause: unknown): 'not_found' | 'forbidden' | 'failed' {
  if (isApiError(cause) && cause.status === 404) return 'not_found';
  if (isApiError(cause) && cause.status === 403) return 'forbidden';
  return 'failed';
}

const done = () => revalidatePath('/[locale]/settings/channels', 'page');

/** Why a refresh of a number with no record here did not happen (Backend 7131f530). */
export type UnprofiledRefreshResult =
  | WriteResult
  /** 429: once a minute per number. */
  | { readonly ok: false; readonly reason: 'too_soon' }
  /** 409: GOTCHA's access to it has expired - only a reconnect brings it back. */
  | { readonly ok: false; readonly reason: 'reconnect' }
  /** 502: Meta did not answer; nothing was changed. */
  | { readonly ok: false; readonly reason: 'meta_silent' };

/**
 * "Refresh from Meta" for a number GOTCHA has no record of (dev's one): the
 * same route, by its channel account id - Meta's number, verified name and
 * quality read again now. Read-only on Meta.
 */
export async function refreshUnprofiled(
  channelAccountId: string,
): Promise<UnprofiledRefreshResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.whatsappRefresh(channelAccountId),
      payload: z.unknown(),
      raw: true,
    });
    done();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    logger.warn('whatsapp.unprofiled_refresh_failed', { status });
    if (status === 429) return { ok: false, reason: 'too_soon' };
    if (status === 409) return { ok: false, reason: 'reconnect' };
    if (status === 502) return { ok: false, reason: 'meta_silent' };
    return { ok: false, reason: reasonOf(cause) };
  }
}

/**
 * 13b's "Refresh from Meta": re-read one number's health from Meta now
 * (POST …/numbers/:id/refresh). Reads Meta; changes nothing there.
 */
export async function refreshNumber(id: string): Promise<WriteResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.whatsappRefresh(id),
      payload: z.unknown(),
      raw: true,
    });
    done();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.refresh_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: reasonOf(cause) };
  }
}

/**
 * 13b · Private contacts: add one ON ONE WhatsApp number (Backend, 2026-10-07:
 * the route requires `channelAccountId`). Re-adding on the same number
 * updates its note; on another number it is a separate rule.
 */
export async function addPrivateContact(input: {
  readonly value: string;
  readonly note: string;
  readonly channelAccountId: string;
}): Promise<AddContactResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.whatsappExclusions(),
      body: {
        value: input.value.trim(),
        ...(input.note.trim() ? { note: input.note.trim() } : {}),
        channelAccountId: input.channelAccountId,
      },
      payload: z.unknown(),
      raw: true,
    });
    done();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    // Two 400s: no number given (never sent by this screen), and a bad phone number.
    if (
      isApiError(cause) &&
      (cause.developerMessage === 'channel_account_required' ||
        cause.developerMessage === 'channel_account_not_found')
    ) {
      return { ok: false, reason: 'number_gone' };
    }
    if (isApiError(cause) && cause.status === 400) return { ok: false, reason: 'invalid_number' };
    logger.warn('whatsapp.exclusion_add_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: reasonOf(cause) };
  }
}

/** 13b · Private contacts: remove one. */
export async function removePrivateContact(id: string): Promise<WriteResult> {
  try {
    await serverApi().delete({
      endpoint: channelEndpoints.whatsappExclusion(id),
      payload: z.unknown(),
      raw: true,
    });
    done();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.exclusion_remove_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: reasonOf(cause) };
  }
}

/**
 * ★ Disconnect a number (DELETE …/numbers/:id). Its channel goes, with its
 * events and private contacts; conversations stay. Only from the
 * confirmation that names the number.
 */
export async function disconnectNumber(id: string): Promise<WriteResult> {
  try {
    await serverApi().delete({
      endpoint: channelEndpoints.whatsappNumber(id),
      payload: z.unknown(),
      raw: true,
    });
    done();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('whatsapp.disconnect_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: reasonOf(cause) };
  }
}
