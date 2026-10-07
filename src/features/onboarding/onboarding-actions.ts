'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { completeSchema, onboardingStatusSchema, siteHost } from '@/api/contracts/onboarding';
import { goLiveEndpoints, onboardingEndpoints } from '@/api/endpoints/registry';
import { paymentPath } from '@/api/client/payment-path';
import { logger } from '@/observability/logger';

import { discoverAfterResponse } from './discover-after';
import { loadDiscovery, loadReading, type ReadingRead } from './load-onboarding';

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

export type FinishResult =
  | {
      readonly ok: true;
      /** Setup is done, and it owes payment: where it pays. */
      readonly payAt: string | null;
      /** `false`: nothing in Knowledge it can answer from - said before the workspace. */
      readonly knowledgeUsable: boolean | null;
    }
  /** No core system, and 00g was not skipped: the route's own sentence. */
  | { readonly ok: false; readonly reason: 'core_system_required'; readonly message: string | null }
  /** No business profile, and the read has no name and description to make one. */
  | { readonly ok: false; readonly reason: 'needs_profile' }
  | { readonly ok: false; readonly reason: 'refused'; readonly message: string | null }
  | { readonly ok: false; readonly reason: 'failed' };

/**
 * 00h's "Open my workspace" - it finishes, for real (Omer, 2026-10-07).
 *
 *   1  the business profile, if none: from the confirmed website read (name,
 *      summary, industry, language, site), as the old setup does - the
 *      route refuses to finish without one
 *   2  POST /api/onboarding/complete, `skipCoreSystem` only when 00g was
 *      skipped; never `skipEmployee` (design 6 has no "meet your employee",
 *      so the recommended one is hired)
 *
 * The route flips the tenant ACTIVE (or PENDING_PAYMENT), hires, provisions
 * billing and sends the activation email.
 */
export async function finishOnboarding(input: {
  readonly skippedCore: boolean;
  readonly locale: string;
}): Promise<FinishResult> {
  try {
    const status = await serverApi().get({
      endpoint: onboardingEndpoints.status(),
      payload: onboardingStatusSchema,
      raw: true,
    });
    if (!status.data.businessProfileCompleted) {
      const discovery = await loadDiscovery();
      const business = discovery?.business ?? null;
      const name = business?.name?.trim() ?? '';
      const description = business?.summary?.trim() ?? '';
      if (!name || !description) return { ok: false, reason: 'needs_profile' };
      await serverApi().post({
        endpoint: onboardingEndpoints.businessProfile(),
        body: {
          organizationName: name.slice(0, 200),
          businessDescription: description.slice(0, 2000),
          industry: business?.industry?.trim() || undefined,
          primaryLanguage: discovery?.brand?.languages[0] || undefined,
          websiteDomain: discovery?.websiteDomain || undefined,
          locale: input.locale,
        },
        payload: z.unknown(),
        raw: true,
      });
    }
    const done = await serverApi().post({
      endpoint: goLiveEndpoints.complete(),
      body: input.skippedCore ? { skipCoreSystem: true } : {},
      payload: completeSchema,
      raw: true,
    });
    return {
      ok: true,
      payAt: done.data.paymentRequired ? await paymentPath() : null,
      knowledgeUsable: done.data.knowledge?.usable ?? null,
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 400) {
      if (cause.developerMessage === 'core_system_required') {
        return { ok: false, reason: 'core_system_required', message: cause.userMessage ?? null };
      }
      return { ok: false, reason: 'refused', message: cause.developerMessage ?? null };
    }
    logger.warn('onboarding.complete_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
