import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  KNOWLEDGE_SEARCH_MAX,
  KNOWLEDGE_SEARCH_MIN,
  knowledgeSearchSchema,
  type KnowledgeSearchHit,
} from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type KnowledgeSearch =
  | {
      readonly state: 'ok';
      readonly q: string;
      readonly hits: readonly KnowledgeSearchHit[];
      readonly hasMore: boolean;
    }
  /** Under 2 or over 200 characters: said, never sent (the route answers 400 for both). */
  | { readonly state: 'short' | 'long'; readonly q: string }
  | { readonly state: 'failed'; readonly q: string };

/** K1: the search, as the screen says it - the query normalised as the route does. */
export async function searchKnowledge(raw: string): Promise<KnowledgeSearch> {
  const q = raw.replace(/\s+/g, ' ').trim();
  if (q.length < KNOWLEDGE_SEARCH_MIN) return { state: 'short', q };
  if (q.length > KNOWLEDGE_SEARCH_MAX) return { state: 'long', q };
  try {
    const answer = await serverApi().get({
      endpoint: knowledgeEndpoints.search(),
      payload: knowledgeSearchSchema,
      query: { q, limit: 20 },
      // `data` sits beside `q` and `hasMore`: unwrapped, the parse would fail.
      raw: true,
    });
    return { state: 'ok', q, hits: answer.data, hasMore: answer.hasMore };
  } catch (cause) {
    if (isApiError(cause) && cause.code === 'QUERY_TOO_SHORT') return { state: 'short', q };
    if (isApiError(cause) && cause.code === 'QUERY_TOO_LONG') return { state: 'long', q };
    logger.warn('knowledge.search_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { state: 'failed', q };
  }
}
