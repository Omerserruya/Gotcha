'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  employeeTestSchema,
  goLiveSchema,
  type EmployeeTest,
  type GoLive,
} from '@/api/contracts/onboarding-v2';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type GoLiveResult =
  | { readonly ok: true; readonly live: GoLive }
  | {
      readonly ok: false;
      readonly reason: 'not_learned' | 'awaiting_payment' | 'suspended' | 'failed';
    };

const GO_LIVE_REFUSED: Readonly<Record<string, Exclude<GoLiveResult, { ok: true }>['reason']>> = {
  NOT_LEARNED: 'not_learned',
  TENANT_AWAITING_PAYMENT: 'awaiting_payment',
  TENANT_SUSPENDED: 'suspended',
};

/**
 * The one press: the first employee, made from what was learned, routed to
 * the connected channels, the workspace opened (Backend's /go-live). Sends
 * nothing to anyone. Idempotent: a second press updates the same employee.
 */
export async function goLive(employeeName: string): Promise<GoLiveResult> {
  const name = employeeName.trim();
  try {
    const live = await serverApi().post({
      endpoint: onboardingEndpoints.goLive(),
      body: { confirm: true, ...(name ? { employeeName: name } : {}) },
      payload: goLiveSchema,
      timeoutMs: 60_000,
    });
    return { ok: true, live };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const known = isApiError(cause) && cause.code ? GO_LIVE_REFUSED[cause.code] : undefined;
    if (known) return { ok: false, reason: known };
    logger.warn('onboarding.go_live_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

export type EmployeeTestResult =
  | { readonly ok: true; readonly test: EmployeeTest }
  | {
      readonly ok: false;
      readonly reason: 'not_live' | 'question_required' | 'too_long' | 'rate_limited' | 'failed';
      readonly retryAfterSeconds?: number | null;
    };

/**
 * Ask the employee that just went live, in a SANDBOX (Backend's
 * onboarding-employee-test): the real runtime with its read-only order
 * tools, in a sandbox conversation the inbox never shows - no channel, no
 * outbox, nothing sent. Says when it answered from a real order.
 */
export async function askEmployee(question: string): Promise<EmployeeTestResult> {
  try {
    const test = await serverApi().post({
      endpoint: onboardingEndpoints.employeeTest(),
      body: { question: question.trim() },
      payload: employeeTestSchema,
      timeoutMs: 60_000,
    });
    return { ok: true, test };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.code === 'NOT_LIVE') return { ok: false, reason: 'not_live' };
      if (cause.code === 'QUESTION_REQUIRED') return { ok: false, reason: 'question_required' };
      if (cause.code === 'QUESTION_TOO_LONG') return { ok: false, reason: 'too_long' };
      if (cause.code === 'PREVIEW_RATE_LIMITED') {
        return {
          ok: false,
          reason: 'rate_limited',
          retryAfterSeconds: cause.retryAfterSeconds ?? null,
        };
      }
    }
    logger.warn('onboarding.employee_test_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}
