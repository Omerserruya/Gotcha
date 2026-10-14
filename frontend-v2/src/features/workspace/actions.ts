'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  acceptResultSchema,
  prohibitedClaimsSchema,
  scanRunSchema,
  scanStateSchema,
  type AcceptResult,
  type ScanRun,
  type Workspace,
  type WorkspaceVoice,
  voiceSampleSchema,
  workspaceSchema,
  workspaceVoiceSchema,
} from '@/api/contracts/workspace';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Writes for screen 11.
 *
 * Server actions rather than browser calls: every one of these is a write, and
 * routing them through the server keeps the BFF's origin check and the session
 * cookie doing their jobs without the form knowing either exists.
 *
 * They return a result rather than throwing, because the interesting failures
 * here are not exceptions - a stale write and a failed validation are both
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
 * `hours` is replaced wholesale, never merged - it describes a whole week, and
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
    await signInIfSignedOut(cause);
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
    await signInIfSignedOut(cause);
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
 * fallback on purpose - a sample the model never produced would be the one
 * thing worse than no preview - and the screen must not dress that as an
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
    await signInIfSignedOut(cause);
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
    await signInIfSignedOut(cause);
    logger.warn('workspace.claims_save_failed', { cause });
    return classify(cause);
  }
}

/** How a rescan start went: the run it started (or found running), or why not. */
export type ScanStart =
  | { readonly ok: true; readonly run: ScanRun }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/**
 * Scan the website again - screen 11b, as a run (2026-10-14).
 *
 * ★ THIS RE-CRAWLS A LIVE SITE. Safe in the one way that matters: it writes
 * only fields the scan already owns, offers the rest, and refreshes only the
 * knowledge it generated - a document a person edited is kept.
 *
 * ★ IT ANSWERS AT ONCE. A crawl and a model call take 25-40 seconds, and the
 * browser and the BFF stopped waiting at 20: the screen said "the scan did
 * not run" while it finished. So POST only starts it (202) and the screen
 * reads `readWorkspaceScan` until it ends. A scan already running (409
 * SCAN_IN_PROGRESS) carries that run: it is followed, not refused.
 */
export async function startWorkspaceScan(locale?: string): Promise<ScanStart> {
  try {
    const run = await serverApi().post({
      endpoint: workspaceEndpoints.scan(),
      payload: scanRunSchema,
      body: locale ? { locale } : {},
    });
    return { ok: true, run };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'SCAN_IN_PROGRESS') {
      const running = scanRunSchema.safeParse(cause.errorData);
      return {
        ok: true,
        run: running.success ? running.data : scanRunSchema.parse({ status: 'running' }),
      };
    }
    logger.warn('workspace.scan_failed', { cause });
    return {
      ok: false,
      reason: isApiError(cause) && cause.status === 403 ? 'forbidden' : 'failed',
    };
  }
}

/**
 * The last rescan, as the server has it: running, done or failed - or `null`
 * when none was ever started. `undefined` when it could not be read.
 */
export async function readWorkspaceScan(): Promise<ScanRun | null | undefined> {
  try {
    const state = await serverApi().get({
      endpoint: workspaceEndpoints.scan(),
      payload: scanStateSchema,
    });
    if (state.run && state.run.status !== 'running') {
      revalidatePath('/[locale]/settings/workspace', 'page');
    }
    return state.run;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('workspace.scan_read_failed', { cause });
    return undefined;
  }
}

/**
 * Take the website's value for offered fields.
 *
 * ★ STAMPS THEM `scan`-OWNED, NOT `human`. Provenance answers one question -
 * may a future scan refresh this silently? - so it records what the value
 * TRACKS rather than who clicked. Accepting the site's wording IS the consent
 * a silent refresh needs.
 *
 * A plain PATCH cannot be used and must not be: PATCH means "a human set
 * this" and has to keep meaning that, or the distinction is lost in the other
 * direction. Before this endpoint existed, `scan` ownership was unreachable
 * and every scan offered everything forever.
 *
 * The body carries FIELD NAMES ONLY - values come from the stored proposal,
 * so a client cannot mark arbitrary text as website-owned.
 */
export async function acceptScanFields(fields: readonly string[]): Promise<AcceptResult | null> {
  try {
    const data = await serverApi().post({
      endpoint: workspaceEndpoints.scanAccept(),
      payload: acceptResultSchema,
      body: { fields },
    });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('workspace.scan_accept_failed', { cause });
    return null;
  }
}

/** A language write: done, refused (no permission), or failed. */
export type LanguageResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

async function putLocale(
  endpoint: ReturnType<typeof workspaceEndpoints.systemLocale>,
  locale: string,
  event: string,
): Promise<LanguageResult> {
  try {
    await serverApi().put({ endpoint, payload: z.unknown(), body: { locale } });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn(event, { cause });
    return {
      ok: false,
      reason: isApiError(cause) && cause.status === 403 ? 'forbidden' : 'failed',
    };
  }
}

/**
 * The workspace's system language (Omer, 2026-10-11: "you can't change the
 * system language"). The route existed all along; the screen drew the field
 * as a fixed box.
 */
export async function saveSystemLanguage(locale: string): Promise<LanguageResult> {
  return putLocale(workspaceEndpoints.systemLocale(), locale, 'workspace.system_locale_failed');
}
