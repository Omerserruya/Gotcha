'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { storeProbeSchema, type StoreProbe } from '@/api/contracts/woo-probe';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type ProbeOutcome =
  | { readonly ok: true; readonly probe: StoreProbe }
  /** 404 NO_STORE: no store connected or being connected in the last hour. */
  | { readonly ok: false; readonly reason: 'no_store' | 'forbidden' | 'failed' };

/**
 * Ask GOTCHA's servers to try the workspace's WooCommerce store now. Takes no
 * address: the route checks the store it knows (Backend fb28bd20), so this
 * can never be pointed at someone else's site. Never rejects.
 */
export async function probeWooStore(): Promise<ProbeOutcome> {
  try {
    const probe = await serverApi().get({
      endpoint: channelEndpoints.wooProbeStore(),
      payload: storeProbeSchema,
    });
    return { ok: true, probe };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 404) return { ok: false, reason: 'no_store' };
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('capabilities.woo_probe_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
