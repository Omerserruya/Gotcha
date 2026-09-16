'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  prohibitedClaimsSchema,
  voiceSampleSchema,
  workspaceSchema,
  workspaceVoiceSchema,
  type Workspace,
  type WorkspaceVoice,
} from '@/api/contracts/workspace';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Writes for screen 11.
 *
 * Server actions rather than browser calls: every one of these is a write, and
 * routing them through the server keeps the BFF's origin check and the session
 * cookie doing their jobs without the form knowing either exists.
 *
 * They return a result rather than throwing, because the interesting failures
 * here are not exceptions — a stale write and a failed validation are both
 * answers the form has to render, not errors to catch.
 */

/** Every write answers with one of these. */
export type WriteResult<T> =
  | { readonly ok: true; readonly data: T }
  /** The record moved under us. The form offers to reload, never to force. */
  | { readonly ok: false; readonly reason: 'stale' }
  /** Per-field, from the server. Rendered beside the field that failed. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly fields: Record<string, string> }
  /** No business profile yet: onboarding has not run. Its own message. */
  | { readonly ok: false; readonly reason: 'no_profile' }
  | { readonly ok: false; readonly reason: 'failed' };

function fieldErrorsOf(cause: unknown): Record<string, string> {
  if (!isApiError(cause)) return {};
  return Object.fromEntries(cause.fieldErrors.map((f) => [f.field, f.message]));
}

function classify(cause: unknown): WriteResult<never> {
  if (isApiError(cause)) {
    if (cause.code === 'STALE_WRITE') return { ok: false, reason: 'stale' };
    if (cause.code === 'NO_BUSINESS_PROFILE') return { ok: false, reason: 'no_profile' };
    if (cause.kind === 'validation') {
      return { ok: false, reason: 'invalid', fields: fieldErrorsOf(cause) };
    }
  }
  return { ok: false, reason: 'failed' };
}

/**
 * Patches the workspace facts.
 *
 * `If-Match` carries the `updatedAt` the form was rendered from, so a second
 * editor cannot silently overwrite the first. The server only enforces it when
 * sent, which is why it is always sent from here.
 *
 * `hours` is replaced wholesale, never merged — it describes a whole week, and
 * merging a partial one produces a schedule nobody wrote.
 */
export async function saveWorkspaceFacts(
  patch: Record<string, unknown>,
  expectedUpdatedAt: string | null,
): Promise<WriteResult<Workspace>> {
  try {
    const data = await serverApi().patch({
      endpoint: workspaceEndpoints.read(),
      payload: workspaceSchema,
      body: patch,
      ...(expectedUpdatedAt ? { headers: { 'if-match': expectedUpdatedAt } } : {}),
    });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return { ok: true, data };
  } catch (cause) {
    logger.warn('workspace.patch_failed', { cause });
    return classify(cause);
  }
}

/**
 * Saves the voice, or reverts it.
 *
 * An empty `guidance` is a revert: it clears the edit stamp so the next import
 * can learn the voice again. The server reports `reverted: true` and the
 * screen says so, because "we threw your text away" and "we handed this back
 * to the learner" look identical from a blank box.
 */
export async function saveWorkspaceVoice(guidance: string): Promise<WriteResult<WorkspaceVoice>> {
  try {
    const data = await serverApi().put({
      endpoint: workspaceEndpoints.voice(),
      payload: workspaceVoiceSchema,
      body: { guidance },
    });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return { ok: true, data };
  } catch (cause) {
    logger.warn('workspace.voice_save_failed', { cause });
    return classify(cause);
  }
}

/**
 * Previews what a voice would actually sound like.
 *
 * Sends the DRAFT rather than reading storage: the question is "what would
 * this do", asked before anyone commits to it.
 *
 * `unavailable` is its own outcome. The server returns 503 with no canned
 * fallback on purpose — a sample the model never produced would be the one
 * thing worse than no preview — and the screen must not dress that as an
 * ordinary error, because it is expected whenever the AI service is down.
 */
export async function previewVoiceSample(
  guidance: string,
): Promise<{ ok: true; reply: string } | { ok: false; reason: 'unavailable' | 'failed' }> {
  try {
    const data = await serverApi().post({
      endpoint: workspaceEndpoints.voiceSample(),
      payload: voiceSampleSchema,
      body: { guidance },
    });
    return { ok: true, reply: data.reply };
  } catch (cause) {
    if (isApiError(cause) && cause.code === 'SAMPLE_UNAVAILABLE') {
      return { ok: false, reason: 'unavailable' };
    }
    logger.warn('workspace.sample_failed', { cause });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Replaces the prohibited-claims list.
 *
 * Whole-list replace, so add and remove are edits to a local list followed by
 * one write. These are few and short, and an add/remove API would need ids for
 * strings that have none.
 */
export async function saveProhibitedClaims(
  claims: readonly string[],
): Promise<WriteResult<{ claims: string[] }>> {
  try {
    const data = await serverApi().put({
      endpoint: workspaceEndpoints.prohibitedClaims(),
      payload: prohibitedClaimsSchema,
      body: { claims },
    });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return { ok: true, data };
  } catch (cause) {
    logger.warn('workspace.claims_save_failed', { cause });
    return classify(cause);
  }
}
