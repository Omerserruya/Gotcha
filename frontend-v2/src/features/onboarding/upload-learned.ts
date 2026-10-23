import { isApiError } from '@/api/client/api-error';
import { browserApi } from '@/api/client/browser-api';
import { learnedUploadSchema, type LearnedUpload } from '@/api/contracts/onboarding-v2';
import { onboardingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** Backend's cap (e2e8623f). Said before sending, so a big file never travels for nothing. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** What Backend reads; the old binary .doc is not among them. */
export const UPLOAD_TYPES = ['.pdf', '.docx', '.txt', '.md'] as const;

export type UploadRefusal =
  'too_large' | 'unsupported' | 'unreadable' | 'nothing_found' | 'not_learned' | 'failed';

export type UploadResult =
  | { readonly ok: true; readonly result: LearnedUpload }
  | { readonly ok: false; readonly reason: UploadRefusal };

const REFUSED: Readonly<Record<string, UploadRefusal>> = {
  FILE_TOO_LARGE: 'too_large',
  UNSUPPORTED_TYPE: 'unsupported',
  UNREADABLE_FILE: 'unreadable',
  NOTHING_FOUND: 'nothing_found',
  NOT_LEARNED: 'not_learned',
};

/** Refused here, before any upload, when the file can't be one Backend reads. */
export function uploadProblem(file: File): UploadRefusal | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'too_large';
  const name = file.name.toLowerCase();
  return UPLOAD_TYPES.some((type) => name.endsWith(type)) ? null : 'unsupported';
}

/**
 * A file the owner has - a policy document, a FAQ, a price list - read into
 * what was learned and the knowledge base. From the browser through the BFF
 * (as a knowledge file is), never through a server action: an action's body
 * is capped at 1MB, and Backend takes 5MB.
 */
export async function uploadLearned(file: File): Promise<UploadResult> {
  const problem = uploadProblem(file);
  if (problem) return { ok: false, reason: problem };
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const result = await browserApi.post({
      endpoint: onboardingEndpoints.learnedUpload(),
      payload: learnedUploadSchema,
      body: form,
      // Three extractions in parallel take a few seconds; never cut one short.
      timeoutMs: 120_000,
    });
    return { ok: true, result };
  } catch (cause) {
    const known = isApiError(cause) && cause.code ? REFUSED[cause.code] : undefined;
    if (known) return { ok: false, reason: known };
    // Never the file or its name: they are the tenant's.
    logger.warn('onboarding.upload_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
