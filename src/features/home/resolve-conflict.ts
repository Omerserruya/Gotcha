'use server';

import { serverApi } from '@/api/client/server-api';
import { intelligenceReviewEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { z } from 'zod';

/**
 * Settles one knowledge conflict.
 *
 * A server action rather than a browser call: the decision is a write, and
 * routing it through the server keeps the BFF's origin check and the session
 * cookie doing their jobs without the page needing to know either exists.
 *
 * Returns a result rather than throwing. The caller has already applied the
 * change optimistically and needs to know whether to keep it, not to catch.
 */
export async function resolveConflict(
  id: string,
  decision: 'approve' | 'reject',
): Promise<{ ok: boolean }> {
  try {
    await serverApi().post({
      endpoint:
        decision === 'approve'
          ? intelligenceReviewEndpoints.approve(id)
          : intelligenceReviewEndpoints.reject(id),
      payload: z.unknown(),
      raw: true,
    });
    return { ok: true };
  } catch (cause) {
    logger.warn('home.conflict_resolve_failed', { decision, cause });
    return { ok: false };
  }
}
