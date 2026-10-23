'use server';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { learnedSchema, type Learned, type LearnedSection } from '@/api/contracts/onboarding-v2';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What the scan learned, read and corrected (Backend's /learned). Every edit
 * rewrites what the AI reads at once, and answers the whole learned shape,
 * so the screen redraws from the server, never from a guess.
 */
export type LearnedRead =
  | { readonly ok: true; readonly learned: Learned }
  /** `not_learned`: nothing was learned yet (NOT_LEARNED) - back to step 1. */
  | { readonly ok: false; readonly reason: 'not_learned' | 'unread' };

export async function readLearned(): Promise<LearnedRead> {
  try {
    const learned = await serverApi().get({
      endpoint: onboardingEndpoints.learned(),
      payload: learnedSchema,
    });
    return { ok: true, learned };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'NOT_LEARNED')
      return { ok: false, reason: 'not_learned' };
    logger.warn('onboarding.learned_read_failed', { cause });
    return { ok: false, reason: 'unread' };
  }
}

export interface LearnedEdit {
  readonly section: LearnedSection;
  /** The item: a policy's kind, a question's id. Absent for a new question. */
  readonly id?: string;
  readonly value?: Readonly<Record<string, unknown>>;
  readonly remove?: true;
}

export type LearnedEditResult =
  | { readonly ok: true; readonly learned: Learned }
  | {
      readonly ok: false;
      /** gone: the item no longer exists (NOT_FOUND); incomplete: a question needs both halves. */
      readonly reason: 'gone' | 'not_learned' | 'incomplete' | 'failed';
    };

const REFUSED: Readonly<Record<string, 'gone' | 'not_learned' | 'incomplete'>> = {
  NOT_FOUND: 'gone',
  NOT_LEARNED: 'not_learned',
  Q_AND_A_REQUIRED: 'incomplete',
};

export async function editLearned(edit: LearnedEdit): Promise<LearnedEditResult> {
  try {
    const learned = await serverApi().patch({
      endpoint: onboardingEndpoints.learned(),
      body: edit,
      payload: learnedSchema,
    });
    return { ok: true, learned };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const known = isApiError(cause) && cause.code ? REFUSED[cause.code] : undefined;
    if (known) return { ok: false, reason: known };
    logger.warn('onboarding.learned_edit_failed', { section: edit.section, cause });
    return { ok: false, reason: 'failed' };
  }
}
