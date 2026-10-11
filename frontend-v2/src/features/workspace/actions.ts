'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  acceptResultSchema,
  prohibitedClaimsSchema,
  scanResultSchema,
  type AcceptResult,
  type ScanResult,
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

/**
 * Scan the website again - screen 11b.
 *
 * ★ THIS RE-CRAWLS A LIVE SITE. It is not free and it is not instant, but it
 * is safe in the one way that matters: `planRescan` writes only fields the
 * scan already owns, and everything else comes back as a proposal. On a
 * tenant whose provenance map is empty - which is every tenant on this
 * database - it therefore writes nothing at all.
 *
 * Refusals arrive as `{ ok: false, reason }` with a 200, because "you have not
 * told us your website yet" and "the site did not answer" are sentences the
 * screen shows rather than errors it has to decode. The one exception is a
 * scan already running, which is a 409.
 */
export async function runWorkspaceScan(): Promise<ScanResult | null> {
  try {
    const data = await serverApi().post({
      endpoint: workspaceEndpoints.scan(),
      payload: scanResultSchema,
      body: {},
    });
    revalidatePath('/[locale]/settings/workspace', 'page');
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    // A 409 lands here too. Reported as a refusal rather than a crash, since
    // "try again shortly" is the action either way.
    logger.warn('workspace.scan_failed', { cause });
    return null;
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

/** This person's own interface language - kept, so it is theirs on every device. */
export async function saveMyLanguage(locale: string): Promise<LanguageResult> {
  return putLocale(workspaceEndpoints.myLocale(), locale, 'workspace.my_locale_failed');
}
