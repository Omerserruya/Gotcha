import 'server-only';

import { notSamePairsSchema } from '@/api/contracts/identity';
import { serverApi } from '@/api/client/server-api';
import { identityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The pairs somebody marked "not the same person", as `pairKey`s - so the
 * duplicate suggestion never offers one again. `null` is a failed read: then
 * which pairs were marked is unknown, and the card suggests none rather
 * than risk the one a person already turned down.
 */
export async function loadNotSame(): Promise<ReadonlySet<string> | null> {
  try {
    const keys = await serverApi().get({
      endpoint: identityEndpoints.notSame(),
      payload: notSamePairsSchema,
    });
    return new Set(keys);
  } catch (cause) {
    logger.warn('customers.not_same_failed', { cause });
    return null;
  }
}
