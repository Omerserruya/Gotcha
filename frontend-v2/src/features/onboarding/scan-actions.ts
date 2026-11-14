'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { siteHost } from '@/api/contracts/onboarding';
import { discoverJobSchema, jobStartSchema, type DiscoverJob } from '@/api/contracts/onboarding-v2';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Learning the site, as a job (Backend, feat/onboarding-v2): started once,
 * read every second, retried from where it stopped. The job runs on the
 * server whether or not this tab stays open, and a reload picks it up where
 * it is - starting the same address again resumes it (no 409).
 *
 * `legalAccepted: true`: a clickwrap - the line under 00d's button says
 * continuing is agreeing, and the route audit-logs the consent.
 */
export type ScanStart =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'invalid' | 'failed' };

export async function startScan(address: string, locale: string): Promise<ScanStart> {
  const domain = siteHost(address);
  if (domain === null) return { ok: false, reason: 'invalid' };
  try {
    await serverApi().post({
      endpoint: onboardingEndpoints.discoverJob(),
      body: { domain, locale, legalAccepted: true },
      payload: jobStartSchema,
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'INVALID_DOMAIN')
      return { ok: false, reason: 'invalid' };
    logger.warn('onboarding.scan_start_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/** One look at the job: its events after `since`. `none`: no scan was ever started (NO_JOB). */
export type ScanRead =
  | { readonly ok: true; readonly job: DiscoverJob }
  | { readonly ok: false; readonly reason: 'none' | 'unread' };

export async function readScan(since: number): Promise<ScanRead> {
  try {
    const job = await serverApi().get({
      endpoint: onboardingEndpoints.discoverJob(),
      query: { since: String(Math.max(0, Math.floor(since))) },
      payload: discoverJobSchema,
    });
    return { ok: true, job };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'NO_JOB') return { ok: false, reason: 'none' };
    logger.warn('onboarding.scan_read_failed', { cause });
    return { ok: false, reason: 'unread' };
  }
}

/**
 * Pick a FAILED or STALLED job up from its last finished stage. A job that
 * already finished (JOB_COMPLETE) or is alive again needs nothing: the
 * screen keeps reading it. `false`: the retry itself failed.
 */
export async function retryScan(): Promise<boolean> {
  try {
    await serverApi().post({
      endpoint: onboardingEndpoints.discoverRetry(),
      payload: jobStartSchema,
    });
    return true;
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'JOB_COMPLETE') return true;
    logger.warn('onboarding.scan_retry_failed', { cause });
    return false;
  }
}
