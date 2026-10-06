'use server';

import { siteHost } from '@/api/contracts/onboarding';

import { discoverAfterResponse } from './discover-after';

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
