'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { knowledgeDocumentUpdateSchema } from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * K11 (Omer, 2026-10-13): one knowledge item edited, or deleted, from its
 * drawer.
 *
 * ⚠ THESE WRITE THE KNOWLEDGE EVERY AI EMPLOYEE ANSWERS FROM. Tests mock
 * `serverApi`; nothing automated edits or deletes real knowledge.
 *
 * ── WHAT THE ROUTE REALLY DOES (services/ai `knowledge.ts`) ──
 * PUT `/:id/documents/:docId` - `ai:knowledge:write` or ADMIN, scoped by
 * tenant AND base in its WHERE (another tenant's id is a 404):
 *   title     stored trimmed; blank keeps the old one
 *   content   blank keeps the old text. Different from what is stored: the
 *             item goes back to `pending`, its vectors are dropped FIRST, and
 *             it is processed again - re-chunked, re-embedded, and its summary
 *             remade (keyed on a hash of the content). Unchanged: nothing.
 *   manualEdit  `true` is stamped into the metadata, and stays once there.
 *             The website scan's reconciler reports such an item `preserved`
 *             and never rewrites or removes it (Backend 196fea72 covers a page
 *             gone from the site and duplicate cleanup too) - see
 *             `document-edit.ts` for which items that covers.
 * It answers the row with `reprocessing`: whether the content changed.
 *
 * DELETE same path, same permission: the item's vectors, then the row.
 *
 * Every save here sends `manualEdit: true` - it is a person's edit - and
 * only the fields that changed. A blank title or content is refused here:
 * the route would keep the old value and answer 200, and "Saved" would be a
 * lie.
 */

export type DocumentSave =
  | { readonly ok: true; readonly reprocessing: boolean }
  | {
      readonly ok: false;
      readonly reason:
        'unchanged' | 'empty_title' | 'empty_content' | 'forbidden' | 'gone' | 'failed';
    };

export type DocumentDelete =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'forbidden' | 'gone' | 'failed' };

export async function saveDocument(
  baseId: string,
  docId: string,
  change: { readonly title?: string; readonly content?: string },
): Promise<DocumentSave> {
  if (change.title === undefined && change.content === undefined) {
    return { ok: false, reason: 'unchanged' };
  }
  if (change.title !== undefined && change.title.trim() === '') {
    return { ok: false, reason: 'empty_title' };
  }
  if (change.content !== undefined && change.content.trim() === '') {
    return { ok: false, reason: 'empty_content' };
  }
  if (!baseId) return { ok: false, reason: 'failed' };
  try {
    const answer = await serverApi().put({
      endpoint: knowledgeEndpoints.document(baseId, docId),
      body: {
        ...(change.title !== undefined ? { title: change.title.trim() } : {}),
        ...(change.content !== undefined ? { content: change.content } : {}),
        manualEdit: true,
      },
      payload: knowledgeDocumentUpdateSchema,
    });
    revalidatePath('/[locale]/(app)/studio/knowledge', 'page');
    return { ok: true, reprocessing: answer.reprocessing };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const refused = refusal(cause);
    if (refused) return { ok: false, reason: refused };
    logger.warn('knowledge.document_save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

export async function deleteDocument(baseId: string, docId: string): Promise<DocumentDelete> {
  if (!baseId) return { ok: false, reason: 'failed' };
  try {
    await serverApi().delete({
      endpoint: knowledgeEndpoints.document(baseId, docId),
      payload: z.unknown(),
    });
    revalidatePath('/[locale]/(app)/studio/knowledge', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const refused = refusal(cause);
    if (refused) return { ok: false, reason: refused };
    logger.warn('knowledge.document_delete_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

/**
 * A 403 is a permission, never a failure - unless it is the tenant that is
 * gated (`TENANT_*`, kind `tenant_inactive`), which no permission fixes. A
 * 404: not in this tenant and this base, or deleted since the drawer opened.
 */
function refusal(cause: unknown): 'forbidden' | 'gone' | null {
  if (!isApiError(cause)) return null;
  if (cause.status === 403 && cause.kind !== 'tenant_inactive') return 'forbidden';
  if (cause.status === 404) return 'gone';
  return null;
}
