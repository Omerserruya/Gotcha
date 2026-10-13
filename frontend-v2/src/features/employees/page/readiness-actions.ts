'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { builderEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type ReadinessRunResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' | 'missing' | 'slow' | 'failed' };

/**
 * H7, "Run again": one readiness test, stored on the employee by the server
 * (`POST builder/:id/readiness-test`, Admin and up). One LLM call; it answers
 * when the report is stored, so the page reads it again after. Written in the
 * language of the person who asked.
 */
export async function rerunReadiness(employeeId: string): Promise<ReadinessRunResult> {
  if (!employeeId) return { ok: false, reason: 'failed' };
  try {
    await serverApi().post({
      endpoint: builderEndpoints.readinessTest(employeeId),
      body: { locale: await getLocale() },
      payload: z.unknown(),
      // A model call that writes a whole report, not a lookup.
      timeoutMs: 120_000,
    });
    revalidatePath('/[locale]/studio/employees', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('employees.readiness_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'missing' };
      // The server keeps running it and stores it when done: not a failure.
      if (cause.kind === 'timeout') return { ok: false, reason: 'slow' };
    }
    return { ok: false, reason: 'failed' };
  }
}
