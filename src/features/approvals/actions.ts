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

/**
 * The three writes on screen 03.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──
 * **There is no edit action, and there will not be one.**
 * `TenantToolPermission.allowModification` exists to say *"the approver may
 * not change the parameters before this runs"*, it defaults to `false`, and
 * the approve route **never reads it** — zero occurrences in the route file.
 * It accepts `modifiedParams` from the request body on a bare
 * `typeof === "object"` check, and `row.modifiedParams ?? row.params` is what
 * then executes.
 *
 * So a tenant can switch that setting off, see it saved, and anyone who can
 * approve can still rewrite the amount on a refund. Building the UI would not
 * merely sit on that hole — it would make it **routinely exercised** instead of
 * theoretical: today it needs a hand-crafted request, with an edit box it needs
 * a click. And it is the one control on this screen that changes how much money
 * moves, with no undo anywhere in the platform behind it.
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
  | { readonly ok: false; readonly reason: 'failed' };

function classify(cause: unknown, event: string): ApprovalWriteResult {
  if (isApiError(cause)) {
    if (cause.status === 409) return { ok: false, reason: 'stale' };
    if (cause.status === 403) return { ok: false, reason: 'forbidden' };
  }
  logger.warn(event, { cause });
  return { ok: false, reason: 'failed' };
}

/**
 * Approve.
 *
 * **No `modifiedParams` is sent**, ever — see the note at the top of the file.
 * The action that runs is the action that was reviewed.
 */
export async function approveRequest(id: string): Promise<ApprovalWriteResult> {
  try {
    const result = await serverApi().post({
      endpoint: approvalEndpoints.approve(id),
      payload: approveResultSchema,
      body: {},
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
    return classify(cause, 'approvals.retry_failed');
  }
}
