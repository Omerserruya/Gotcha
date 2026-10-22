import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  knowledgeDocumentDetailSchema,
  type KnowledgeDocumentDetail,
  type KnowledgeSource,
} from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * K6: one knowledge item, for its drawer (`?doc=<id>` on 08).
 *
 * Four outcomes, each said differently - never an empty drawer:
 *   ok          the document
 *   not_found   404, or not in any source this page read (another tenant's
 *               id, another base's, or since deleted)
 *   forbidden   403 - no `ai:knowledge:read`
 *   failed      anything else, or the sources themselves could not be read
 */
export type DocumentRead =
  | { readonly state: 'ok'; readonly document: KnowledgeDocumentDetail }
  | { readonly state: 'not_found' | 'forbidden' | 'failed' };

/** The base holding this document, from the list the page already read. */
export function baseOfDocument(
  sources: readonly KnowledgeSource[] | null,
  docId: string,
): string | null | 'unknown' {
  if (sources === null) return 'unknown';
  return sources.find((s) => s.documents.some((d) => d.id === docId))?.id ?? null;
}

export async function loadKnowledgeDocument(
  sources: readonly KnowledgeSource[] | null,
  docId: string,
): Promise<DocumentRead> {
  const baseId = baseOfDocument(sources, docId);
  if (baseId === 'unknown') return { state: 'failed' };
  if (baseId === null) return { state: 'not_found' };
  try {
    const document = await serverApi().get({
      endpoint: knowledgeEndpoints.document(baseId, docId),
      payload: knowledgeDocumentDetailSchema,
    });
    return { state: 'ok', document };
  } catch (cause) {
    logger.warn('knowledge.document_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 404) return { state: 'not_found' };
      if (cause.status === 403) return { state: 'forbidden' };
    }
    return { state: 'failed' };
  }
}
