'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type DisconnectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_found' | 'forbidden' | 'failed' };

/**
 * A channel row's Disconnect (POST /api/channels/:id/disconnect).
 *
 * What the route does (services/auth routes/channels.ts): the platform is told
 * to stop sending (Meta's page subscription, Gmail's watch, Outlook's
 * subscription, Slack's token), then the account is kept but marked
 * DISCONNECTED and inactive, and its credentials are cleared. Inbound
 * webhooks only accept active accounts, so messages stop; conversations are
 * not touched. A failed platform call does not stop the local disconnect.
 *
 * Refusals: 404 not this workspace's, 403 no `channels:manage:update`.
 */
export async function disconnectChannel(id: string): Promise<DisconnectResult> {
  try {
    await serverApi().post({
      endpoint: channelEndpoints.disconnect(id),
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/settings/channels', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const status = isApiError(cause) ? cause.status : undefined;
    logger.warn('channels.disconnect_failed', { status });
    if (status === 404) return { ok: false, reason: 'not_found' };
    if (status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}
