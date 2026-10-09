import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { isNotConfigured } from '@/api/client/not-configured';
import { browserApi } from '@/api/client/browser-api';
import { knowledgeDocumentSchema } from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { KnowledgeBaseRef } from './add-way';

export type { KnowledgeLanding } from './add-way';

/**
 * 08b's three live ways in - a document, a page, a typed fact - (Omer,
 * 2026-10-04). From the browser, as `send-media` is: a 10 MB file does not
 * belong in a server action's body.
 *
 * Every one lands in the tenant's knowledge base - the newest active one, as
 * ChatCenter's own screen picks; dev has one per tenant. With none, one is
 * made first, which is the only extra write here.
 */

/** What the platform reads, and its own limit. */
export const DOCUMENT_TYPES = ['.pdf', '.docx', '.doc', '.md', '.txt'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type AddResult =
  | { readonly ok: true; readonly title: string; readonly status: string }
  | {
      readonly ok: false;
      /**
       * `too_large` · `wrong_type` · `bad_url` - refused here, nothing sent;
       * `unreadable` - the platform could not get text out of it (400);
       * `entitlement` · `forbidden` · `failed`.
       */
      readonly reason:
        | 'too_large'
        | 'wrong_type'
        | 'bad_url'
        | 'unreadable'
        | 'entitlement'
        | 'forbidden'
        | 'failed';
    };

export type AddInput =
  | { readonly way: 'text'; readonly title: string; readonly body: string }
  | { readonly way: 'page'; readonly url: string }
  | { readonly way: 'document'; readonly file: File };

/** An http(s) address, or null. */
export function pageAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function documentProblem(file: File): 'too_large' | 'wrong_type' | null {
  const name = file.name.toLowerCase();
  if (!DOCUMENT_TYPES.some((ext) => name.endsWith(ext))) return 'wrong_type';
  if (file.size > MAX_DOCUMENT_BYTES) return 'too_large';
  return null;
}

const created = z.object({ id: z.string().min(1) });

export async function addKnowledge(
  base: KnowledgeBaseRef,
  input: AddInput,
  newBaseName: string,
): Promise<AddResult> {
  // Refused here, before anything is written - a base included.
  if (base === 'unknown') return { ok: false, reason: 'failed' };
  if (input.way === 'page' && pageAddress(input.url) === null)
    return { ok: false, reason: 'bad_url' };
  if (input.way === 'document') {
    const problem = documentProblem(input.file);
    if (problem) return { ok: false, reason: problem };
  }

  try {
    const baseId =
      base === 'none'
        ? (
            await browserApi.post({
              endpoint: knowledgeEndpoints.createBase(),
              payload: created,
              body: { name: newBaseName },
            })
          ).id
        : base.id;

    if (input.way === 'document') {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      const doc = await browserApi.post({
        endpoint: knowledgeEndpoints.upload(baseId),
        payload: knowledgeDocumentSchema,
        body: form,
        timeoutMs: 120_000,
      });
      return { ok: true, title: doc.title, status: doc.status };
    }

    const doc = await browserApi.post({
      endpoint: knowledgeEndpoints.addDocument(baseId),
      payload: knowledgeDocumentSchema,
      body:
        input.way === 'text'
          ? { title: input.title.trim(), content: input.body.trim(), sourceType: 'text' }
          : { sourceType: 'url', sourceUrl: pageAddress(input.url) },
      timeoutMs: 60_000,
    });
    return { ok: true, title: doc.title, status: doc.status };
  } catch (cause) {
    // Never the content, the file name or the address: all are the tenant's.
    logger.warn('knowledge.add_failed', {
      way: input.way,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'unreadable' };
      if (cause.status === 402) return { ok: false, reason: 'entitlement' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type ConnectStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'not_configured' | 'forbidden' | 'failed' };

/**
 * 08b's Drive and Confluence - live (backend df9ee4cd). The provider's page
 * is asked for here, then the browser goes there; the way back lands on this
 * sheet with `connected=1` or `error=<code>`. Nothing is connected until the
 * person approves at the provider. A base is needed first, as for any source.
 */
export async function startKnowledgeConnect(
  base: KnowledgeBaseRef,
  connector: 'google_drive' | 'confluence',
  newBaseName: string,
): Promise<ConnectStart> {
  if (base === 'unknown') return { ok: false, reason: 'failed' };
  try {
    const baseId =
      base === 'none'
        ? (
            await browserApi.post({
              endpoint: knowledgeEndpoints.createBase(),
              payload: created,
              body: { name: newBaseName },
            })
          ).id
        : base.id;
    const { url } = await browserApi.get({
      endpoint: knowledgeEndpoints.oauthInit(
        connector === 'google_drive' ? 'google-drive' : 'confluence',
        baseId,
      ),
      payload: z.object({ url: z.string().url() }),
      raw: true,
    });
    if (new URL(url).protocol !== 'https:') return { ok: false, reason: 'failed' };
    return { ok: true, url };
  } catch (cause) {
    logger.warn('knowledge.connect_failed', {
      connector,
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    if (isNotConfigured(cause)) return { ok: false, reason: 'not_configured' };
    return { ok: false, reason: 'failed' };
  }
}
