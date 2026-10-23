'use server';

import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { savedStepSchema, type SavedStep } from '@/api/contracts/onboarding-v2';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Save the step reached (Continue or Skip), so a return - a reload, another
 * day, a provider's page coming back - resumes exactly there. `false`: not
 * saved; the way on still works, and resuming falls back to what the server
 * can prove.
 */
export async function saveStep(step: SavedStep): Promise<boolean> {
  try {
    await serverApi().patch({
      endpoint: onboardingEndpoints.step(),
      body: { step },
      payload: savedStepSchema,
    });
    return true;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('onboarding.step_save_failed', { step, cause });
    return false;
  }
}
