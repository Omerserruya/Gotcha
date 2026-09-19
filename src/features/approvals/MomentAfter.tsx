'use client';

import { useTranslations } from 'next-intl';

import { isRetryable, type Approval } from '@/api/contracts/approvals';

import styles from './Approvals.module.css';

/**
 * Screen 03b — *"the moment after"*.
 *
 * ── WHY THIS IS NOT THE SCREEN THAT WAS DRAWN ──
 * The design shows a confirmation with four green steps and a **live Undo for
 * the stated reversibility window**. There is no undo in this platform: no
 * route, no gateway path, no `undoneAt` or `reversalOf` field, enumerated
 * across the repository. `retry-execution` runs the action **forward**, which
 * on a refund is the opposite of reversing it.
 *
 * So a countdown that cannot cancel anything is not built. What is built is
 * the thing the backend was reshaped to make visible, in its own words:
 *
 *   *"A manager approving is not the action happening… without this, a
 *   dispatch that failed left an APPROVED row indistinguishable from one that
 *   succeeded, nothing could retry it, and the customer was simply never told
 *   anything."*
 *
 * **At the moment after a decision, only the first of the design's four ticks
 * is true.** This panel holds the three facts in the order they become
 * knowable, and it is only interesting when one of them went wrong — which is
 * exactly when somebody needs to be looking at it.
 *
 *   1. **the decision** — certain, immediate
 *   2. **the execution** — from `dispatch` in the approve response itself,
 *      synchronously; no poll, no subscription, no optimistic guess
 *   3. **the customer** — `customerNotifiedAt`, which the backend uses as the
 *      once-only guard for the continuation message, so "they were told" is a
 *      **fact** here rather than an inference
 *
 * Retry sits where Undo was drawn. It is the affordance that exists, and it
 * answers the case the design has no state for at all.
 */
export function MomentAfter({
  outcome,
  onRetry,
  busy,
}: {
  readonly outcome: {
    readonly summary: string;
    /** `undefined` where the route answered before reporting a dispatch. */
    readonly dispatched: boolean | undefined;
    readonly dispatchError: string | null | undefined;
    /** The row as the server now holds it. */
    readonly approval: Approval | undefined;
  };
  readonly onRetry: (id: string) => void;
  readonly busy: boolean;
}) {
  const t = useTranslations('approvals');
  const { approval } = outcome;
  const customerTold = approval?.customerNotifiedAt != null;

  return (
    <section
      className={styles.momentAfter}
      data-testid="moment-after"
      data-dispatched={outcome.dispatched === false ? 'no' : 'yes'}
    >
      <h2 className={styles.momentHeading} data-testid="moment-decision">
        {t('moment.decided', { summary: outcome.summary })}
      </h2>

      <ol className={styles.momentFacts}>
        {/* 1 · The decision. The only one that is certain here. */}
        <li className={styles.momentFact} data-testid="moment-fact-decision">
          {t('moment.factDecision')}
        </li>

        {/*
          2 · The execution, from the approve response. The design draws this
          as always-green; it is the step that actually fails.
        */}
        <li
          className={styles.momentFact}
          data-testid="moment-fact-execution"
          data-state={outcome.dispatched === false ? 'failed' : 'ok'}
        >
          {outcome.dispatched === false
            ? t('moment.factExecutionFailed')
            : t('moment.factExecutionRan')}
          {outcome.dispatched === false && outcome.dispatchError ? (
            <span className={styles.momentDetail} data-testid="moment-error">
              {outcome.dispatchError}
            </span>
          ) : null}
        </li>

        {/*
          3 · The customer. A fact, not an inference — `customerNotifiedAt` is
          the backend's own once-only guard for the continuation message.

          "Not yet" is deliberately not "failed": delivery may still be
          retried, and saying it failed would be a claim we cannot support.
        */}
        <li
          className={styles.momentFact}
          data-testid="moment-fact-customer"
          data-state={customerTold ? 'ok' : 'pending'}
        >
          {customerTold ? t('moment.factCustomerTold') : t('moment.factCustomerNotYet')}
        </li>
      </ol>

      {/*
        Where the design drew Undo. This runs the action AGAIN, forward, and
        the copy says so — there is nothing here that could be mistaken for
        taking the refund back.
      */}
      {approval && isRetryable(approval) ? (
        <button
          type="button"
          className={styles.retry}
          data-testid="moment-retry"
          disabled={busy}
          onClick={() => onRetry(approval.id)}
        >
          {t('action.retry')}
        </button>
      ) : null}
    </section>
  );
}
