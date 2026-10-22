'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  activatedSchema,
  automationOneSchema,
  catalogSchema,
  refusalSchema,
  runListSchema,
  runOneSchema,
  validationSchema,
  webhookTriggerSchema,
  type Automation,
  type AutomationRun,
  type Catalog,
  type Issue,
  type RunStep,
  type TriggerType,
  type WebhookTrigger,
} from '@/api/contracts/automations';
import { automationEndpoints } from '@/api/endpoints/registry';
import { redirect } from '@/i18n/navigation';
import { logger } from '@/observability/logger';

export type LiveResult =
  | { readonly ok: true; readonly automation: Automation; readonly warnings: readonly Issue[] }
  /** 422: what stops it going live - the validator's own issues. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly errors: readonly Issue[] }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/** The issues a 422 carried (`ApiError.issues`); `null` when it was not a refusal. */
function refusalOf(cause: unknown): readonly Issue[] | null {
  if (!isApiError(cause) || cause.status !== 422) return null;
  const parsed = refusalSchema.safeParse({ error: 'validation_failed', ...cause.issues });
  return parsed.success ? parsed.data.errors : [];
}

/**
 * 09c's switch. On: activate - the route validates first and refuses with
 * the issues (no_steps, missing_config…). Off: pause, which records who and
 * when.
 */
export async function setLive(id: string, live: boolean): Promise<LiveResult> {
  try {
    if (live) {
      const answer = await serverApi().post({
        endpoint: automationEndpoints.activate(id),
        payload: activatedSchema,
        raw: true,
      });
      revalidatePath('/[locale]/studio/automations', 'layout');
      return { ok: true, automation: answer.data, warnings: answer.warnings };
    }
    const answer = await serverApi().post({
      endpoint: automationEndpoints.pause(id),
      payload: automationOneSchema,
      raw: true,
    });
    revalidatePath('/[locale]/studio/automations', 'layout');
    return { ok: true, automation: answer.data, warnings: [] };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const errors = refusalOf(cause);
    if (errors !== null) return { ok: false, reason: 'invalid', errors };
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('automations.live_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * 09e's catalogue, path-aware: after which step, in which automation, on
 * which channel. With neither, it is the first step - only triggers.
 * `null`: unread.
 */
export async function readCatalog(
  where: {
    readonly automationId?: string;
    readonly after?: string;
    readonly channel?: string;
  } = {},
): Promise<Catalog | null> {
  try {
    const answer = await serverApi().get({
      endpoint: automationEndpoints.catalog(),
      payload: catalogSchema,
      raw: true,
      query: { automationId: where.automationId, after: where.after, channel: where.channel },
    });
    return answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.catalog_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

export type CreateResult =
  | { readonly ok: true; readonly automation: Automation }
  /** 422 at a field (`trigger.config.tags`…); 402 the plan's limit; 403. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly field: string | null }
  | { readonly ok: false; readonly reason: 'limit' | 'forbidden' | 'failed' };

/**
 * New automation: always a draft, with its trigger step on the canvas - and,
 * made, its builder opened BY THIS ACTION (`redirect`), never by the screen.
 *
 * ★★ AU2 (dev, 2026-10-14, measured): the screen pushed to the new builder as
 * soon as the result reached it - streamed, before the action finished - and
 * then the action's `revalidatePath(layout)` payload (780 KB, the whole tree)
 * landed and replaced the router's state, aborting that navigation. The URL
 * stayed on ?new=1 for ever and every retry made another draft. Now nothing is
 * revalidated (the builder reads its automation fresh, and the list is
 * dynamic) and the navigation IS the action's response.
 */
export async function createAutomation(body: {
  readonly name: string;
  readonly trigger: { readonly type: TriggerType; readonly config: Record<string, unknown> };
  /** A template's graph; without one the route starts with the trigger step alone. */
  readonly nodes?: readonly unknown[];
  readonly edges?: readonly unknown[];
}): Promise<CreateResult> {
  let made: Automation;
  try {
    const answer = await serverApi().post({
      endpoint: automationEndpoints.create(),
      body,
      payload: automationOneSchema,
      raw: true,
    });
    made = answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 422) return { ok: false, reason: 'invalid', field: cause.field ?? null };
      if (cause.status === 402) return { ok: false, reason: 'limit' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('automations.create_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
  // Outside the try: a redirect is thrown, and the catch above would swallow it.
  redirect({ href: `/studio/automations/${made.id}`, locale: await getLocale() });
  return { ok: true, automation: made };
}

export type SaveResult =
  | {
      readonly ok: true;
      readonly automation: Automation;
      /** Published: saved, and live (or it already was). */
      readonly live: boolean;
      readonly warnings: readonly Issue[];
      /** Saved as a draft, but it could not go live: why. */
      readonly blocked: readonly Issue[];
    }
  /** A live automation's save was refused - nothing stored - with the issues. */
  | { readonly ok: false; readonly reason: 'invalid'; readonly errors: readonly Issue[] }
  | { readonly ok: false; readonly reason: 'stale' | 'forbidden' | 'failed' };

/**
 * 09d's "Publish changes" (contract v1: until versioned publish, it is PUT
 * then - if not live - activate). A live automation's PUT is validated and
 * refused whole; a draft's is stored, and then going live can still be
 * refused - the draft is kept, and the issues are said.
 */
export async function publishAutomation(
  id: string,
  body: {
    readonly name: string;
    readonly trigger: { readonly type: string; readonly config: Record<string, unknown> };
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
    readonly expectedUpdatedAt: string;
  },
): Promise<SaveResult> {
  let saved: Automation;
  try {
    const answer = await serverApi().put({
      endpoint: automationEndpoints.one(id),
      body,
      payload: automationOneSchema,
      raw: true,
    });
    saved = answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    const errors = refusalOf(cause);
    if (errors !== null) return { ok: false, reason: 'invalid', errors };
    if (isApiError(cause) && cause.status === 409) return { ok: false, reason: 'stale' };
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    logger.warn('automations.save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
  revalidatePath('/[locale]/studio/automations', 'layout');
  if (saved.status === 'live')
    return { ok: true, automation: saved, live: true, warnings: [], blocked: [] };
  const live = await setLive(id, true);
  if (live.ok)
    return {
      ok: true,
      automation: live.automation,
      live: true,
      warnings: live.warnings,
      blocked: [],
    };
  return {
    ok: true,
    automation: saved,
    live: false,
    warnings: [],
    blocked: live.reason === 'invalid' ? live.errors : [],
  };
}

/** 09d's run log, a page at a time. `null`: unread. */
export async function readRuns(
  id: string,
  cursor: string | null,
): Promise<{ readonly runs: readonly AutomationRun[]; readonly nextCursor: string | null } | null> {
  try {
    const answer = await serverApi().get({
      endpoint: automationEndpoints.runs(id),
      payload: runListSchema,
      raw: true,
      query: { limit: '20', cursor: cursor ?? undefined },
    });
    return { runs: answer.data, nextCursor: answer.nextCursor };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.runs_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

/** One run, step by step. `null`: unread, or a run this viewer may not see. */
export async function readRun(
  runId: string,
): Promise<(AutomationRun & { readonly steps: readonly RunStep[] }) | null> {
  try {
    const answer = await serverApi().get({
      endpoint: automationEndpoints.run(runId),
      payload: runOneSchema,
      raw: true,
    });
    return answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.run_failed', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}

/** The webhook trigger's address: provisions one (idempotent) for this automation. */
export async function provisionWebhook(automationId: string): Promise<WebhookTrigger | null> {
  try {
    const answer = await serverApi().post({
      endpoint: automationEndpoints.webhookTriggers(),
      body: { workflowId: automationId },
      payload: webhookTriggerSchema,
      raw: true,
    });
    return answer.data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.webhook_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

/**
 * Delete (DELETE /api/automations/:id). The route deletes the automation and,
 * by cascade, its runs; a conversation parked on one of its runs is released.
 * `false`: it was not deleted.
 */
export async function deleteAutomation(id: string): Promise<boolean> {
  try {
    await serverApi().delete({
      endpoint: automationEndpoints.one(id),
      payload: z.unknown(),
      raw: true,
    });
    /*
      No revalidate (AU2): its tree in this response would replace the
      router's state under the builder's push back to the list. The list
      drops deleted rows itself, and reads fresh when it is opened.
    */
    return true;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.delete_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return false;
  }
}

/**
 * The canvas, checked as it is - unsaved - by the route's own validator
 * (POST /:id/validate). `null`: not checked this time.
 */
export async function checkGraph(
  id: string,
  body: {
    readonly trigger: { readonly type: string; readonly config: Record<string, unknown> };
    readonly nodes: readonly unknown[];
    readonly edges: readonly unknown[];
  },
): Promise<{ readonly errors: readonly Issue[]; readonly warnings: readonly Issue[] } | null> {
  try {
    return await serverApi().post({
      endpoint: automationEndpoints.validate(id),
      body,
      payload: validationSchema,
      raw: true,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('automations.validate_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}
