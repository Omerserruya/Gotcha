import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import {
  discoveryReadSchema,
  onboardingStatusSchema,
  siteFromEmail,
  siteHost,
  type Discovery,
} from '@/api/contracts/onboarding';
import { authEndpoints, onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** Where 00d's guess came from - its line under the title says so. */
export type GuessSource = 'scan' | 'profile' | 'email';

export interface WebsiteRead {
  /** The host to confirm, or `null`: nothing to guess from - the question opens. */
  readonly guess: { readonly host: string; readonly from: GuessSource } | null;
  readonly email: string | null;
  /** The business's name as the workspace knows it. */
  readonly business: string | null;
  /** The last scan, when there was one - what 00d's card can say it found. */
  readonly discovery: Discovery | null;
}

/**
 * 00d. The guess, in order: the site a scan already read, the site the
 * profile holds, the site the work address implies. A free mail domain
 * implies none. Each read failing just narrows the guess - 00d always has its
 * question to fall back to.
 */
export async function loadWebsiteStep(): Promise<WebsiteRead> {
  const [me, status, discovery] = await Promise.all([
    serverApi()
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .catch(() => null),
    serverApi()
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((r) => r.data)
      .catch((cause: unknown) => {
        logger.warn('onboarding.status_failed', { cause });
        return null;
      }),
    loadDiscovery(),
  ]);
  const email = me?.user.email ?? null;
  const fromScan = discovery?.websiteDomain ? siteHost(discovery.websiteDomain) : null;
  const fromProfile = status?.businessProfile?.websiteDomain
    ? siteHost(status.businessProfile.websiteDomain)
    : null;
  const fromEmail = siteFromEmail(email);
  const guess = fromScan
    ? { host: fromScan, from: 'scan' as const }
    : fromProfile
      ? { host: fromProfile, from: 'profile' as const }
      : fromEmail
        ? { host: fromEmail, from: 'email' as const }
        : null;
  return {
    guess,
    email,
    business:
      discovery?.business?.name?.trim() ||
      status?.businessProfile?.organizationName?.trim() ||
      me?.tenantName?.trim() ||
      null,
    discovery,
  };
}

/** The scan's row. `null`: never scanned - or unread, which 00d treats the same way. */
export async function loadDiscovery(): Promise<Discovery | null> {
  try {
    const read = await serverApi().get({
      endpoint: onboardingEndpoints.discovery(),
      payload: discoveryReadSchema,
      raw: true,
    });
    return read.data.discovery;
  } catch (cause) {
    logger.warn('onboarding.discovery_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}
