import 'server-only';

import { importListSchema, type ImportStatus } from '@/api/contracts/historical-import';
import { candidateListSchema, type Candidate } from '@/api/contracts/knowledge-candidates';
import { numbersResponseSchema, type NumbersResponse } from '@/api/contracts/whatsapp-numbers';
import { channelEndpoints, knowledgeEndpoints } from '@/api/endpoints/registry';
import { serverApi } from '@/api/client/server-api';
import { logger } from '@/observability/logger';

/**
 * WhatsApp numbers — screen 13.
 *
 * One read, and the failure is NOT degraded into an empty list. An empty list
 * on this screen means "you have no WhatsApp numbers", which is a statement
 * about the workspace; a failed read is a statement about us. Conflating them
 * would tell somebody whose numbers are working that they have none.
 */
export async function loadWhatsAppNumbers(): Promise<NumbersResponse | null> {
  return serverApi()
    .get({
      endpoint: channelEndpoints.whatsappNumbers(),
      payload: numbersResponseSchema,
      // `{ data, unprofiled }` — the second array has no envelope of its own,
      // so the response is needed whole.
      raw: true,
    })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.numbers_failed', { cause });
      return null;
    });
}

/**
 * Screens 13e and 13f — the history import, and the suggestions it produced.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "NO IMPORT" AND "UNAVAILABLE" ARE DIFFERENT FACTS
 * ════════════════════════════════════════════════════════════════════════════
 * `stage: 'unavailable'` comes from a real row whose status is `NOT_AVAILABLE`
 * — **an import exists and the platform reported it cannot be done.** An empty
 * `imports: []` is nobody ever starting one.
 *
 * So `status` is `null` for "there is no import", and `ImportProgress` is not
 * rendered at all in that case. Synthesising an `unavailable` status would put
 * *"we can't import your history"* on the screen of a workspace that never
 * asked — a confident refusal invented out of an empty list.
 *
 * ── AND THE CANDIDATES BELONG TO AN IMPORT, NOT TO THE TENANT ──
 * `knowledge-clustering.stage.ts` queries `where: { importId, tenantId }`, so
 * there is no tenant-wide read of suggestions. Without an import there is
 * nothing to review, and 13f is absent for the same reason as 13e rather than
 * for a reason of its own.
 */
export interface HistoryImportData {
  /** The newest import, or `null` — there is none, or the read failed. */
  readonly status: ImportStatus | null;
  /** Its suggestions. `null` when unread; `[]` when the import produced none. */
  readonly candidates: readonly Candidate[] | null;
  /**
   * The server's bulk-approve floor, `undefined` when it did not say.
   *
   * Never defaulted: a number invented here is a claim about what pressing
   * "approve all" would take, and the route sends this precisely so the client
   * does not guess. See `bulkWouldTake`.
   */
  readonly bulkMinConfidence: number | undefined;
}

export async function loadHistoryImport(): Promise<HistoryImportData> {
  const api = serverApi();

  const imports = await api
    .get({ endpoint: knowledgeEndpoints.imports(), payload: importListSchema })
    .then((page) => page.imports)
    .catch((cause: unknown) => {
      logger.warn('whatsapp.imports_failed', { cause });
      return null;
    });

  /*
   * Newest first per the route, so the first row is the current import. `null`
   * covers both a failed read and an empty list — and the difference does not
   * change what the screen can say, because neither gives it an import to
   * report on.
   */
  const status = imports?.[0] ?? null;
  if (status === null) return { status: null, candidates: null, bulkMinConfidence: undefined };

  const page = await api
    .get({ endpoint: knowledgeEndpoints.candidates(status.id), payload: candidateListSchema })
    .catch((cause: unknown) => {
      logger.warn('whatsapp.candidates_failed', { cause });
      return null;
    });

  return {
    status,
    candidates: page?.candidates ?? null,
    bulkMinConfidence: page?.bulkApproveMinConfidence,
  };
}
