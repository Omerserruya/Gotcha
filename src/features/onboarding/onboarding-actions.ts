'use server';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { siteHost } from '@/api/contracts/onboarding';
import { onboardingEndpoints } from '@/api/endpoints/registry';
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

/**
 * 00h's Teach: the answer to a real question, into Knowledge - where every
 * employee answers from. `false`: it was not learned (the route says so when
 * it could not embed it), or the request failed.
 */
export async function teachAnswer(
  question: string,
  answer: string,
  locale: string,
): Promise<boolean> {
  try {
    const answered = await serverApi().post({
      endpoint: onboardingEndpoints.teach(),
      body: { label: question.trim().slice(0, 200), method: 'text', value: answer.trim(), locale },
      payload: z.object({ data: z.looseObject({ ok: z.boolean() }) }),
      raw: true,
    });
    return answered.data.ok;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('onboarding.teach_failed', { cause });
    return false;
  }
}
