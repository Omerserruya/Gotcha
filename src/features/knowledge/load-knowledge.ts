import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  knowledgeListSchema,
  unansweredListSchema,
  type KnowledgeSource,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 08 reads.
 *
 * Two independent reads. Either can fail on its own and the screen degrades
 * rather than blanking: a tenant whose sources load but whose unanswered
 * questions do not still learns what GOTCHA knows, which is the screen's
 * first question.
 */
export interface KnowledgeData {
  readonly sources: readonly KnowledgeSource[] | null;
  readonly unanswered: readonly UnansweredQuestion[] | null;
}

export async function loadKnowledge(): Promise<KnowledgeData> {
  const api = serverApi();

  const [sources, unanswered] = await Promise.all([
    api
      .get({ endpoint: knowledgeEndpoints.sources(), payload: knowledgeListSchema })
      .catch((cause: unknown) => {
        logger.warn('knowledge.sources_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: knowledgeEndpoints.unanswered(),
        payload: unansweredListSchema,
        raw: true,
        // Open ones only: an answered question is not a gap any more, and
        // the screen is about what GOTCHA cannot answer.
        query: { status: 'open' },
      })
      .then((page) => page.data)
      .catch((cause: unknown) => {
        logger.warn('knowledge.unanswered_failed', { cause });
        return null;
      }),
  ]);

  return { sources, unanswered };
}
