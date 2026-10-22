import 'server-only';

import { after } from 'next/server';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The scan, run after the answer is sent: ONE long request on the backend
 * (crawl, synthesis, knowledge ingest). Nobody is waiting on it here - 00e
 * reads its progress from the discovery row - so a failure is logged and
 * shows there as FAILED, or as a scan that never started. No sign-in
 * redirect: the response it would ride on is already gone.
 *
 * `legalAccepted: true`: a clickwrap - the line under 00d's button says
 * continuing is agreeing, and the route audit-logs the consent (supervisor;
 * with Omer).
 */
export function discoverAfterResponse(domain: string, locale: string): void {
  after(async () => {
    try {
      await serverApi().post({
        endpoint: onboardingEndpoints.discover(),
        body: { domain, locale, legalAccepted: true },
        payload: z.unknown(),
        raw: true,
      });
    } catch (cause) {
      logger.warn('onboarding.discover_failed', {
        status: isApiError(cause) ? cause.status : undefined,
      });
    }
  });
}
