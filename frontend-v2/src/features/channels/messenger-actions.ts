'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  MESSENGER_SELECT_MAX,
  messengerCandidatesSchema,
  messengerSelectSchema,
  type MessengerCandidate,
  type MessengerPageResult,
} from '@/api/contracts/channels';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

const CHANNELS = '/[locale]/(app)/settings/channels';

/**
 * Messenger's Page picker (backend 0ce84f21): the Pages a sign-in offered,
 * and connecting the ones chosen. Contract in `contracts/channels.ts`.
 *
 * Nothing here logs the session id or the Page ids: the session is the key to
 * Page tokens held for this person, and a failure is logged by status and
 * code alone.
 */

export type MessengerPagesRead =
  | { readonly ok: true; readonly pages: readonly MessengerCandidate[] }
  | { readonly ok: false; readonly reason: 'expired' | 'forbidden' | 'failed' };

/** A 410 is the route's one answer for expired, replaced, foreign and another person's. */
const expired = (cause: unknown) =>
  isApiError(cause) && (cause.status === 410 || cause.code === 'SESSION_EXPIRED');

export async function loadMessengerPages(session: string): Promise<MessengerPagesRead> {
  try {
    const { pages } = await serverApi().get({
      endpoint: channelEndpoints.messengerCandidates(session),
      payload: messengerCandidatesSchema,
    });
    return { ok: true, pages };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.messenger_pages_failed', {
      status: isApiError(cause) ? cause.status : undefined,
      code: isApiError(cause) ? cause.code : undefined,
    });
    if (expired(cause)) return { ok: false, reason: 'expired' };
    if (isApiError(cause) && cause.kind === 'authorization') {
      return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type MessengerSelectRefusal =
  /** The session is gone: start again from Connect Messenger. */
  | 'expired'
  /** 402 PLAN_LIMIT_REACHED - too many NEW Pages for the plan. */
  | 'limit'
  /** 409 NONE_CONNECTED - every choice belongs to another workspace. */
  | 'none_connected'
  /** 422 UNKNOWN_PAGE - an id this sign-in did not offer. */
  | 'unknown_page'
  | 'forbidden'
  | 'failed';

export type MessengerSelectResult =
  | { readonly ok: true; readonly results: readonly MessengerPageResult[] }
  | {
      readonly ok: false;
      readonly reason: MessengerSelectRefusal;
      /** The 409's own per-Page answers, when it sent them. */
      readonly results: readonly MessengerPageResult[];
    };

export async function selectMessengerPages(
  session: string,
  pageIds: readonly string[],
): Promise<MessengerSelectResult> {
  const ids = Array.from(new Set(pageIds));
  // The route's own bounds: nothing is asked that it would refuse as malformed.
  if (ids.length === 0 || ids.length > MESSENGER_SELECT_MAX) {
    return { ok: false, reason: 'failed', results: [] };
  }
  try {
    const { results } = await serverApi().post({
      endpoint: channelEndpoints.messengerSelect(),
      payload: messengerSelectSchema,
      body: { session, pageIds: ids },
    });
    revalidatePath(CHANNELS, 'page');
    return { ok: true, results };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.messenger_select_failed', {
      status: isApiError(cause) ? cause.status : undefined,
      code: isApiError(cause) ? cause.code : undefined,
    });
    const refusal = (reason: MessengerSelectRefusal): MessengerSelectResult => ({
      ok: false,
      reason,
      results: [],
    });
    if (expired(cause)) return refusal('expired');
    if (!isApiError(cause)) return refusal('failed');
    // 402 is also the tenant gate's status: told apart by `code`, as `classify` does.
    if (cause.code === 'PLAN_LIMIT_REACHED') return refusal('limit');
    if (cause.code === 'UNKNOWN_PAGE') return refusal('unknown_page');
    if (cause.code === 'NONE_CONNECTED') {
      // Nothing was written; the route still says, per Page, why not.
      const said = messengerSelectSchema.safeParse(cause.errorData ?? {});
      return {
        ok: false,
        reason: 'none_connected',
        results: said.success ? said.data.results : [],
      };
    }
    if (cause.kind === 'authorization') return refusal('forbidden');
    return refusal('failed');
  }
}
