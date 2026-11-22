'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { DOMAIN_JOIN_REFUSALS, domainJoinSchema } from '@/api/contracts/self-signup';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** `taken`: another organization joins by this domain. Anything but `saved` puts the row back. */
export type DomainJoinResult = 'saved' | 'publicDomain' | 'taken' | 'failed';

export async function setDomainJoin(joinByDomain: boolean): Promise<DomainJoinResult> {
  try {
    await serverApi().put({
      endpoint: securityEndpoints.domainJoin(),
      payload: domainJoinSchema,
      body: { joinByDomain },
      raw: true,
    });
    revalidatePath('/[locale]/settings/security', 'page');
    return 'saved';
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('security.domain_join_failed', { cause });
    if (isApiError(cause) && cause.status === 409) {
      if (cause.developerMessage === DOMAIN_JOIN_REFUSALS.taken) return 'taken';
      if (cause.developerMessage === DOMAIN_JOIN_REFUSALS.publicDomain) return 'publicDomain';
    }
    return 'failed';
  }
}
