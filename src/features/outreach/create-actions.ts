'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { outreachEndpoints, templateEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * 05 / 05c — creating outreach (Omer, 2026-10-04): a campaign as a DRAFT, and
 * a template as a local DRAFT. Sending a campaign and submitting a template
 * to Meta are separate writes and stay drawn until they are approved.
 */

export type CreateResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      /** `missing` (a required field), `entitlement`, `forbidden`, `failed`. */
      readonly reason: 'missing' | 'entitlement' | 'forbidden' | 'failed';
    };

const created = z.object({ id: z.string().min(1) });

function refusal(cause: unknown, event: string): CreateResult {
  logger.warn(event, { cause });
  if (isApiError(cause)) {
    if (cause.status === 400) return { ok: false, reason: 'missing' };
    if (cause.status === 402) return { ok: false, reason: 'entitlement' };
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
  }
  return { ok: false, reason: 'failed' };
}

export interface CampaignDraft {
  readonly name: string;
  /** The connected account it goes out from; the route requires it. */
  readonly channelAccountId: string;
  /** The account's channel (`WHATSAPP`, `EMAIL`, …). */
  readonly channel: string;
  /** WhatsApp: an approved template. */
  readonly templateId?: string;
  /** Other channels: the message itself. */
  readonly body?: string;
  /** ISO, or none for "when you send it". */
  readonly scheduledAt?: string;
}

/** POST /api/broadcasts — a DRAFT. Nothing is sent. */
export async function createCampaignDraft(draft: CampaignDraft): Promise<CreateResult> {
  if (!draft.name.trim() || !draft.channelAccountId || (!draft.templateId && !draft.body?.trim())) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const result = await serverApi().post({
      endpoint: outreachEndpoints.list(),
      payload: created,
      body: {
        name: draft.name.trim(),
        channel: draft.channel,
        channelAccountId: draft.channelAccountId,
        ...(draft.templateId ? { templateId: draft.templateId } : { body: draft.body!.trim() }),
        ...(draft.scheduledAt ? { scheduledAt: draft.scheduledAt } : {}),
      },
    });
    revalidatePath('/[locale]/(app)/outreach', 'page');
    return { ok: true, id: result.id };
  } catch (cause) {
    return refusal(cause, 'outreach.create_failed');
  }
}

export interface TemplateDraft {
  readonly name: string;
  readonly body: string;
  /** WhatsApp's categories: `MARKETING`, `UTILITY`, `AUTHENTICATION`. */
  readonly category: string;
  readonly language: string;
  readonly channelAccountId?: string;
  readonly footer?: string;
}

/** POST /api/templates — a local DRAFT. Not submitted to Meta. */
export async function createTemplate(draft: TemplateDraft): Promise<CreateResult> {
  if (!draft.name.trim() || !draft.body.trim()) return { ok: false, reason: 'missing' };
  try {
    const result = await serverApi().post({
      endpoint: templateEndpoints.list(),
      payload: created,
      body: {
        name: draft.name.trim(),
        body: draft.body.trim(),
        category: draft.category,
        language: draft.language,
        ...(draft.channelAccountId ? { channelAccountId: draft.channelAccountId } : {}),
        ...(draft.footer?.trim() ? { footer: draft.footer.trim() } : {}),
      },
    });
    revalidatePath('/[locale]/(app)/outreach/templates', 'page');
    return { ok: true, id: result.id };
  } catch (cause) {
    return refusal(cause, 'templates.create_failed');
  }
}

/** POST /api/templates/:id/duplicate — a copy, as a local DRAFT. */
export async function duplicateTemplate(id: string): Promise<CreateResult> {
  try {
    const result = await serverApi().post({
      endpoint: templateEndpoints.duplicate(id),
      payload: created,
      body: {},
    });
    revalidatePath('/[locale]/(app)/outreach/templates', 'page');
    return { ok: true, id: result.id };
  } catch (cause) {
    return refusal(cause, 'templates.duplicate_failed');
  }
}
