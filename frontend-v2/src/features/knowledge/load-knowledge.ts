import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  knowledgeListSchema,
  unansweredListSchema,
  type KnowledgeSource,
  type UnansweredQuestion,
} from '@/api/contracts/knowledge';
import {
  candidateListSchema,
  conflictsIn,
  type Candidate,
} from '@/api/contracts/knowledge-candidates';
import { importListSchema } from '@/api/contracts/historical-import';
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
  /**
   * Questions the business answered more than one way - the screen's hero.
   *
   * `null` when we could not read them, which is distinct from `[]` meaning
   * nothing contradicts itself. The screen says different things for each.
   */
  readonly conflicts: readonly Candidate[] | null;
  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ WHAT THE CONFLICT LIST IS AND IS NOT, CARRIED TO THE SCREEN
   * ════════════════════════════════════════════════════════════════════════
   * `false` when there has never been an import.
   *
   * Conflict detection runs INSIDE the historical-import pipeline -
   * `knowledge-clustering.stage.ts` queries
   * `where: { importId, tenantId, status: "PENDING" }`. It does not watch
   * live conversations and it does not look at a document uploaded
   * afterwards.
   *
   * So an empty list means *"nothing contradicted itself in what we
   * imported"*, never *"GOTCHA's knowledge is consistent"*. Without this
   * flag the screen cannot tell a tenant with no contradictions from one
   * where nothing has ever looked, and those are opposite sentences.
   */
  readonly everImported: boolean;
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

  /*
   * ★ ORDERED, BECAUSE CONFLICTS BELONG TO AN IMPORT AND NOT TO THE TENANT.
   *
   * There is no tenant-wide read of knowledge candidates: the only list is
   * `/:importId/candidates`, so the import has to land before the conflicts
   * can be asked for. The same shape as 04b's timeline-then-brief, for the
   * same reason - the key comes out of the previous answer.
   *
   * Newest import only. Older ones describe a world the newer one has
   * already re-read, and stacking their conflicts would show a merchant a
   * contradiction they resolved two imports ago.
   */
  const imports = await api
    .get({ endpoint: knowledgeEndpoints.imports(), payload: importListSchema })
    .then((page) => page.imports)
    .catch((cause: unknown) => {
      logger.warn('knowledge.imports_failed', { cause });
      return null;
    });

  const newest = imports?.[0] ?? null;

  const candidates = newest
    ? await api
        .get({
          endpoint: knowledgeEndpoints.candidates(newest.id),
          payload: candidateListSchema,
          // `{ candidates, counts }` - `candidates` is a sibling, not the
          // payload, so the envelope must not be unwrapped.
          raw: true,
          query: { status: 'PENDING' },
        })
        .then((page) => page.candidates)
        .catch((cause: unknown) => {
          logger.warn('knowledge.candidates_failed', { cause });
          return null;
        })
    : [];

  return {
    sources,
    unanswered,
    conflicts: candidates === null ? null : conflictsIn(candidates),
    // `imports === null` is a failed read, not an absence of imports. Only
    // an empty ARRAY means nothing was ever imported.
    everImported: imports !== null && imports.length > 0,
  };
}
