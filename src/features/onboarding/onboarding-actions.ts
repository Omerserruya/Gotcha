'use server';

import { signInIfSignedOut } from '@/api/client/signed-out';
import { siteHost } from '@/api/contracts/onboarding';
import { logger } from '@/observability/logger';

import { discoverAfterResponse } from './discover-after';
import { loadReading, type ReadingRead } from './load-onboarding';

/**
 * 00d's "Yes, read it". The read runs after this answer (`discover-after`),
 * and 00e watches it through the discovery row. Closing the tab does not
 * stop it.
 *
 * `false`: not an address the route would read; nothing was sent.
 */
export async function startReading(address: string, locale: string): Promise<boolean> {
  const domain = siteHost(address);
  if (domain === null) return false;
  discoverAfterResponse(domain, locale);
  return true;
}

/** 00e's poll: the read's row and what it has written so far. `null`: unread this time. */
export async function readReading(): Promise<ReadingRead | null> {
  try {
    return await loadReading();
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('onboarding.reading_failed', { cause });
    return null;
  }
}
