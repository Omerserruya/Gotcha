'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  approveResultSchema,
  type Approval,
  rejectResultSchema,
  retryResultSchema,
} from '@/api/contracts/approvals';
import { approvalEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';
import { signInIfSignedOut } from '@/api/client/signed-out';

/**
 * The three writes on screen 03.
 *
 * ── THERE IS STILL NO EDIT ACTION, AND THE REASON HAS CHANGED ──
 *
 * ⚠ THIS BLOCK USED TO SAY "there will not be one", ON A HOLE THAT IS NOW
 * CLOSED. Corrected 2026-09-24 rather than left standing: it was true when
 * written and false by the time anybody read it, which is the class this
 * project has spent the day chasing. A prose claim about another repo has no
 * test holding it, so nothing failed when it went stale.
 *
 * What it said: `allowModification` was resolved by tool-gate and read by
 * nobody, so an approver could rewrite the amount on a refund whose policy
 * forbade editing, and building the UI would have made that routine rather
 * than theoretical.
 *
 * What is true now — `approvals.ts:1061-1085`, D49, verified here rather
 * than taken on report:
 *
 *     const wantsModification = req.body?.modifiedParams != null && …
 *     if (wantsModification) {
 *       const gate = await evaluateToolGate(tenantId, row.tool);
 *       if (gate.approvalConfig?.allowModification !== true)
 *         → 403 MODIFICATION_NOT_ALLOWED
 *     }
 *
 * It refuses LOUDLY and fails CLOSED — an absent `approvalConfig` is not
 * permission — and the route's own comment gives the reason: falling back to
 * the original params would execute something the approver did not agree to
 * while showing them the version they typed, so the approval record would
 * disagree with what ran.
 *
 * ── SO AN EDIT CONTROL IS NOW BUILDABLE, AND IS NOT BUILT HERE ──
 * It is buildable gated on the tool's policy, with the 403 rendered as its
 * own sentence — "this tool's policy does not allow editing before
 * approval" — rather than a generic failure. That is a separate piece of
 * work with its own ruling; this file does not have it, and this comment no
 * longer claims it never will.
 *
 * ── AND THERE IS NO UNDO ACTION ──
 * Not an omission. No route, no gateway path, no `undoneAt` or `reversalOf`
 * field exists anywhere in the platform. `retryExecution` runs the action
 * **forward**, which on a refund is the opposite of reversing it.
 */

export type ApprovalWriteResult =
  | {
      readonly ok: true;
      /**
       * Present on approve only, and the reason 03b exists.
       *
       * The route answers `{ approval, dispatch }`, so whether the action
       * actually ran comes back **in the response to the decision** — no poll,
       * no subscription. `false` here is an approval that was granted and then
       * failed to execute, which is the case the whole screen is for, reported
       * at the one moment the person who decided is still looking at it.
       */
      readonly dispatched?: boolean;
      readonly dispatchError?: string | null;
      /**
       * The row as the server now holds it, on approve.
       *
       * 03b's third fact — **was the customer told** — is
       * `customerNotifiedAt` on this row, and the backend uses its presence as
       * the once-only guard for the continuation message. So it is a fact
       * rather than an inference, and reading it from the response means the
       * moment-after panel never has to guess or refetch.
       */
      readonly approval?: Approval;
    }
  /**
   * The row moved under us — already decided, or past its deadline.
   *
   * The route answers 409 for both. Its own outcome because the remedy is the
   * same in each case and it is not a fault: the screen reloads and shows what
   * the row actually is now. A five-minute sweeper and a live countdown make
   * this a routine race rather than an edge case.
   */
  | { readonly ok: false; readonly reason: 'stale' }
  /** The route requires a rejection reason and answers 400 without one. */
  | { readonly ok: false; readonly reason: 'reason_required' }
  /** Separation of duties: the approver may not be the requesting actor. */
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'failed' }
  | { readonly ok: false; readonly reason: EditRefusal };

/** Backend 05979604's refusals of an edited amount: nothing decided, nothing sent. */
export const EDIT_REFUSALS = [
  'edit_not_allowed',
  'amount_above_original',
  'invalid_amount',
  'edit_requires_original_amount',
] as const;
export type EditRefusal = (typeof EDIT_REFUSALS)[number];

function classify(cause: unknown, event: string): ApprovalWriteResult {
  if (isApiError(cause)) {
    if (cause.status === 409) return { ok: false, reason: 'stale' };
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    const code = cause.developerMessage ?? '';
    if (cause.status === 400 && (EDIT_REFUSALS as readonly string[]).includes(code)) {
      return { ok: false, reason: code as EditRefusal };
    }
  }
  logger.warn(event, { cause });
  return { ok: false, reason: 'failed' };
}

/**
 * Approve.
 *
 * With `edits` only for an edited amount (backend 05979604, Omer 2026-10-04):
 * `{ edits: { amount } }` — the server checks the tool is allowed, the amount is
 * no more than the original, and refuses 400 otherwise with nothing decided.
 */
export async function approveRequest(
  id: string,
  /**
   * 03's "Edit amount": approved with a lower amount. Sent only when given.
   */
  edits?: { readonly amount: number },
): Promise<ApprovalWriteResult> {
  if (edits !== undefined && !(Number.isFinite(edits.amount) && edits.amount > 0)) {
    return { ok: false, reason: 'failed' };
  }
  try {
    const result = await serverApi().post({
      endpoint: approvalEndpoints.approve(id),
      payload: approveResultSchema,
      body: edits ? { edits: { amount: edits.amount } } : {},
      raw: true,
    });
    revalidatePath('/[locale]/(app)/approvals', 'page');
    // A 200 means the DECISION was recorded. It says nothing on its own about
    // whether the action ran — that is what `dispatch` is for, and conflating
    // the two is the exact mistake the model was reshaped to prevent.
    return {
      ok: true,
      dispatched: result.dispatch.ok,
      dispatchError: result.dispatch.error,
      approval: result.approval,
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return classify(cause, 'approvals.approve_failed');
  }
}

/**
 * Reject, with the reason.
 *
 * The reason is the point: the design's *"tell GOTCHA why, so it stops asking
 * wrongly"* is the one place a rejection becomes more than a no. It is stored
 * on `decisionReason` and shown back on the decided list.
 */
export async function rejectRequest(
  id: string,
  decisionReason: string,
): Promise<ApprovalWriteResult> {
  const reason = decisionReason.trim();
  // The route answers 400 without one, so this is the contract rather than a
  // house style. Caught here so the form says what is missing instead of
  // showing a failure for a field the person can still fill in.
  if (!reason) return { ok: false, reason: 'reason_required' };

  try {
    await serverApi().post({
      endpoint: approvalEndpoints.reject(id),
      payload: rejectResultSchema,
      body: { decisionReason: reason },
      raw: true,
    });
    revalidatePath('/[locale]/(app)/approvals', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return classify(cause, 'approvals.reject_failed');
  }
}

/**
 * Re-dispatch an approved action whose execution FAILED.
 *
 * This is the affordance the design drew an Undo in place of, and it is the
 * opposite one: it runs the action again, forward. It is offered only where
 * `isRetryable` allows — never on `LEGACY_UNVERIFIED`, whose own comment is
 * that many of those rows provably never ran, so re-running an old refund is
 * worse than not knowing.
 */
export async function retryExecution(id: string): Promise<ApprovalWriteResult> {
  try {
    // `{ data }` here, unlike its two siblings — so no `raw`, and `serverApi`
    // unwraps it. Three routes in one file, three envelope shapes.
    const result = await serverApi().post({
      endpoint: approvalEndpoints.retryExecution(id),
      payload: retryResultSchema,
      body: {},
    });
    revalidatePath('/[locale]/(app)/approvals', 'page');
    // A 200 is "we tried again", not "it worked". Same distinction as approve.
    return { ok: true, dispatched: result.executed, dispatchError: result.error };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return classify(cause, 'approvals.retry_failed');
  }
}
