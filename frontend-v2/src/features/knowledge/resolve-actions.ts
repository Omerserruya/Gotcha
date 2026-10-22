'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  answerTooLong,
  approveResultSchema,
  documentUseOf,
  type DocumentUse,
} from '@/api/contracts/knowledge-candidates';
import { knowledgeListSchema } from '@/api/contracts/knowledge';
import { knowledgeEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * Screen 08's resolve.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS WRITES THE KNOWLEDGE BASE EVERY AI EMPLOYEE ANSWERS FROM
 * ════════════════════════════════════════════════════════════════════════════
 * Choosing which of two observed answers is right creates a knowledge document
 * and embeds it, and from then on the AI answers customers out of it. Omer
 * authorized the control knowing that - it was in the question. That is not a
 * reason for anything automated to press it, and **no test and no capture
 * does**: `Resolve.test.tsx` mocks this module to throw.
 *
 * ── ONE TAP IS ENOUGH, BECAUSE THE TAP IS THE ANSWER ──
 * The route refuses a conflicted candidate outright unless the body names an
 * answer - it will not *"silently enshrine whichever variant happened to be
 * most common"*. So the chosen variant's own text IS the payload, sent
 * verbatim, and the screen never has to ask a second question.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT SEND ──
 * **`force`.** It exists, and it skips the duplicate check. The route's reason
 * for running that check at approval rather than only at clustering is that
 * *"approving into a knowledge base that already answers this question is how
 * it starts contradicting itself"* - and a one-tap button is the last place
 * that should be overridable. `already_covered` is reported as an outcome and
 * the reader decides.
 *
 * **`question`.** Omitted, so the route keeps `candidate.question`. The
 * conflict is about the answer; rewriting the question here would change what
 * the document is indexed under without anybody asking for it.
 *
 * **`knowledgeBaseId`.** Omitted. The route falls back to the oldest active
 * base with `scope: "all"`, which is the one every employee reads. Naming a
 * base from this screen would be a routing decision the panel has no basis to
 * make.
 */

export type ResolveResult =
  /**
   * The write landed. `use` says whether the AI can answer with it yet - see
   * `documentUseOf`; `{ ok: true }` alone does not mean the knowledge is live.
   */
  | {
      readonly ok: true;
      readonly use: DocumentUse;
      /** True on the idempotent replay: the document already existed. */
      readonly alreadyApproved: boolean;
    }
  /**
   * 409 - the knowledge base already answers this.
   *
   * ★ NOT A FAILURE, AND IT CHANGED SOMETHING. The route records
   * `duplicateOfDocumentId` on the candidate before refusing, so the row
   * comes back on the next read as already-covered rather than as a conflict.
   * The reader should see a settled row, not a retry.
   *
   * `title` is always `null` today: the route sends `existing.title` and the
   * shared error envelope strips it. Kept in the type because the sentence it
   * would improve is written and waiting for it.
   */
  | { readonly ok: false; readonly reason: 'already_covered'; readonly title: string | null }
  /** 400 - there is no knowledge base to write into. A setup step, not a fault. */
  | { readonly ok: false; readonly reason: 'no_knowledge_base' }
  /** 404 - the candidate is gone, or belongs to another tenant. */
  | { readonly ok: false; readonly reason: 'not_found' }
  /** 403 - `ai:knowledge:write` or ADMIN. A permission, not a fault. */
  | { readonly ok: false; readonly reason: 'forbidden' }
  /** Refused here: the route would store this answer cut off at 4000 chars. */
  | { readonly ok: false; readonly reason: 'too_long' }
  | { readonly ok: false; readonly reason: 'failed' };

export async function resolveConflict(
  candidateId: string,
  chosenAnswer: string,
): Promise<ResolveResult> {
  const answer = chosenAnswer.trim();
  if (!answer) {
    /*
     * The route would answer `conflict_requires_answer`, and rightly. Caught
     * here so an empty variant - which should not exist - cannot produce a
     * refusal whose message the screen would then have to translate back into
     * "nothing was chosen".
     */
    logger.warn('knowledge.resolve_without_answer', { candidateId });
    return { ok: false, reason: 'failed' };
  }
  if (answerTooLong(answer)) {
    // Refused rather than truncated. See `ANSWER_MAX_CHARS`.
    logger.warn('knowledge.resolve_answer_too_long', { candidateId, length: answer.length });
    return { ok: false, reason: 'too_long' };
  }

  let result;
  try {
    result = await serverApi().post({
      endpoint: knowledgeEndpoints.approveCandidate(candidateId),
      // `answer`, not `editedAnswer` - see `APPROVE_BODY_KEY`.
      body: { answer },
      payload: approveResultSchema,
      raw: true,
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      /*
       * ★★ THE DISCRIMINATOR IS `developerMessage`, AND `cause.code` IS DEAD
       * HERE.
       *
       * Every other action in this codebase matches `cause.code` - see
       * `people/actions.ts:66`, `workspace/actions.ts:52`. Those codes come
       * from the *entitlement* envelope in `packages/shared`, which really
       * does send a `code` field. **This service's own route-level refusals
       * do not.** `historical-import.ts` answers
       * `{ error: "no_knowledge_base", message }`, `readErrorBody` maps
       * `error` → `developerMessage`, and `code` stays undefined.
       *
       * So the house idiom, copied here, compiles and never fires: a tenant
       * with no knowledge base would have been told "something went wrong"
       * forever, and the one thing that would fix it would never be named.
       *
       * `developerMessage` is documented "never rendered to end users", which
       * remains true - it is matched on, and the sentence shown is ours.
       */
      const code = cause.developerMessage;
      if (cause.status === 409 || code === 'already_covered') {
        /*
         * The route sends `existing: { documentId, title }`, and we cannot
         * reach it: `errorEnvelopeSchema` names `error`, `details`, `code`,
         * `tenantStatus` and `checkoutPath`, so `z.object` strips `existing`
         * before `ApiError` is built. Recorded rather than worked around -
         * naming the document that already answers this would be a better
         * sentence, and it needs a change to the shared error envelope.
         */
        return { ok: false, reason: 'already_covered', title: null };
      }
      if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
      if (cause.status === 404) return { ok: false, reason: 'not_found' };
      if (code === 'no_knowledge_base') return { ok: false, reason: 'no_knowledge_base' };
      /*
       * `conflict_requires_answer` cannot be reached from here - we always
       * send an answer - so it gets no state of its own. If it ever arrives
       * it means the body key changed underneath us, and `failed` with the
       * message in the log is where that gets found.
       */
    }
    logger.warn('knowledge.resolve_failed', { cause });
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/[locale]/(app)/studio/knowledge', 'page');
  return {
    ok: true,
    alreadyApproved: result.alreadyApproved === true,
    use: await documentUse(result.documentId),
  };
}

/**
 * ★★ THE SECOND READ, WHICH IS WHAT MAKES THE SUCCESS MESSAGE TRUE.
 *
 * The approve response cannot tell us whether the AI can answer with the
 * document, because an embedding failure is caught and discarded inside the
 * route. `GET /api/knowledge-bases` carries each document's `status`, and
 * `ready` is the record that the vectors reached Qdrant.
 *
 * A failed or forbidden read is `unknown`, never `in_use`: that read is gated
 * on `ai:knowledge:read`, which is a *different* permission from the write we
 * just used, so a writer without it is an ordinary case rather than a fault.
 */
async function documentUse(documentId: string | null | undefined): Promise<DocumentUse> {
  if (!documentId) return 'unknown';
  try {
    const bases = await serverApi().get({
      endpoint: knowledgeEndpoints.sources(),
      payload: knowledgeListSchema,
    });
    const document = bases.flatMap((base) => base.documents).find((d) => d.id === documentId);
    // Not found is unknown, not broken: it may sit in a base this reader
    // cannot see.
    return document ? documentUseOf(document.status) : 'unknown';
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('knowledge.resolve_confirm_failed', { documentId, cause });
    return 'unknown';
  }
}
