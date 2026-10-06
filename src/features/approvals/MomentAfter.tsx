'use client';

import { useFormatter, useTranslations } from 'next-intl';

import {
  classifyDispatchError,
  isRetryable,
  plainErrorText,
  providerOf,
  type Approval,
} from '@/api/contracts/approvals';
import { Link } from '@/i18n/navigation';

import styles from './Approvals.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

/** What 03b knows about the decision it follows. */
export interface MomentOutcome {
  readonly summary: string;
  readonly dispatched: boolean | undefined;
  readonly dispatchError: string | null | undefined;
  readonly approval: Approval | undefined;
}

/** One decided request, enough to count a run of the same kind. */
export interface DecidedTrace {
  readonly id: string;
  readonly tool: string;
  readonly status: Approval['status'];
}

/**
 * How many of this kind were approved, this one included — and rejected.
 * The history is the server's snapshot, which after a refresh contains this
 * decision too, so it is excluded by id and counted once.
 */
export function runOf(
  approval: Approval,
  history: readonly DecidedTrace[],
): { approved: number; rejected: number } {
  const same = history.filter((h) => h.tool === approval.tool && h.id !== approval.id);
  return {
    approved: same.filter((h) => h.status === 'APPROVED').length + 1,
    rejected: same.filter((h) => h.status === 'REJECTED').length,
  };
}

/**
 * Screen 03b — the moment after, measured.
 *
 * The right pane becomes the moment until you open the next request:
 *
 *   the confirmation   green-edged (`#C9D8B4`), a check, what was done, how
 *                      long ago; then the chain — recorded, carried out (or
 *                      not, in the provider's words), the customer told
 *   what was sent      the message's state; its text is "—" (not recorded
 *                      on the approval, and the detail route returns inbound
 *                      messages only)
 *   the pattern        after a run of the same kind: how many, from the
 *                      decided history
 *   up next            the next request and "Open it"
 *
 * ⚠ Undo is drawn and not live: there is no undo in this platform, and its
 * tooltip says so. Before a decision nothing mentions reversal at all — see
 * the screen's own test — because a promise read before an irreversible act
 * changes the act. "Add something", the discount, and "Let GOTCHA handle
 * them" (a policy write) are drawn and not live too.
 */
export function MomentAfter({
  outcome,
  history,
  next,
  now,
  onOpenNext,
  onRetry,
  busy,
}: {
  readonly outcome: MomentOutcome;
  readonly history: readonly DecidedTrace[];
  readonly next: {
    readonly summary: string;
    readonly eyebrow: string;
    readonly line: string | null;
  } | null;
  readonly now: Date;
  readonly onOpenNext: () => void;
  readonly onRetry: (id: string) => void;
  readonly busy: boolean;
}) {
  const t = useTranslations('approvals');
  const format = useFormatter();
  const { approval } = outcome;
  const failed = outcome.dispatched === false;
  const customerTold = approval?.customerNotifiedAt != null;
  const decidedAt = approval?.decidedAt ? new Date(approval.decidedAt) : null;
  const run = approval ? runOf(approval, history) : null;
  /*
    ★ RETRY ON THE DISPATCH, NOT ONLY ON THE ROW. The approve route answers
    with the row as it was BEFORE dispatch, so `executionState` there is never
    FAILED — measured on dev, a failed refund offered no retry. The response's
    own `dispatch.ok` is the fact.
  */
  const retryable =
    approval !== undefined && (isRetryable(approval) || (failed && approval.status === 'APPROVED'));
  const failure = failed ? classifyDispatchError(outcome.dispatchError) : null;
  const provider = approval
    ? (providerOf(approval.tool) ?? t('moment.failure.theStore'))
    : t('moment.failure.theStore');

  return (
    <div
      className={styles.moment}
      data-testid="moment-after"
      data-dispatched={failed ? 'no' : 'yes'}
    >
      <section className={styles.momentDone} data-failed={failed ? '' : undefined}>
        <header className={styles.momentDoneHead}>
          <span className={styles.momentCheck} aria-hidden="true">
            {failed ? '!' : '✓'}
          </span>
          <h2 className={styles.momentTitle} data-testid="moment-decision">
            {t('moment.decided', { summary: outcome.summary })}
          </h2>
          {decidedAt ? (
            <span className={styles.momentAgo}>
              {format.relativeTime(
                decidedAt,
                now.getTime() < decidedAt.getTime() ? decidedAt : now,
              )}
            </span>
          ) : null}
          <span className={styles.momentHeadActions}>
            {/*
              Where the design drew Undo, the one that is real when it failed:
              this runs the action AGAIN, forward, and says so.
            */}
            {retryable && approval ? (
              <button
                type="button"
                className={styles.momentButton}
                data-testid="moment-retry"
                disabled={busy}
                onClick={() => onRetry(approval.id)}
              >
                {t('action.retry')}
              </button>
            ) : null}
            {/* Undo belongs to an action that was carried out; a failed one has nothing to undo. */}
            {failed ? null : (
              <span
                className={styles.momentButton}
                aria-disabled="true"
                title={t('moment.noUndo')}
                data-testid="moment-undo"
              >
                {t('moment.undo')}
              </span>
            )}
          </span>
        </header>

        <ol className={styles.momentChain}>
          {/* 1 · The decision. The only one that is certain here. */}
          <li className={styles.momentStep} data-testid="moment-fact-decision" data-state="ok">
            {t('moment.factDecision')}
          </li>
          {/* 2 · The execution, from the approve response — the step that actually fails. */}
          <li
            className={styles.momentStep}
            data-testid="moment-fact-execution"
            data-state={failed ? 'failed' : 'ok'}
          >
            {failed ? t('moment.factExecutionFailed') : t('moment.factExecutionRan')}
            {/*
              ★ Why, as a sentence by class — never the provider's text, which
              arrived once as Shopify's whole HTML error page. The text, plain
              and cut short, is the tooltip for whoever is debugging.
            */}
            {failure ? (
              <span
                className={styles.momentDetail}
                data-testid="moment-error"
                data-failure={failure}
                title={plainErrorText(outcome.dispatchError) ?? undefined}
              >
                {t(`moment.failure.${failure}` as 'moment.failure.unknown', { provider })}
                {failure === 'connection' ? (
                  <>
                    {' '}
                    <Link
                      href={{ pathname: '/settings/systems' }}
                      className={styles.momentFix}
                      data-testid="moment-reconnect"
                    >
                      {t('moment.failure.reconnect')}
                    </Link>
                  </>
                ) : null}
              </span>
            ) : null}
          </li>
          {/*
            3 · The customer: `customerNotifiedAt`, the backend's own once-only
            guard. "Not yet" is not "failed" — delivery may still be retried.
          */}
          <li
            className={styles.momentStep}
            data-testid="moment-fact-customer"
            data-state={customerTold ? 'ok' : 'pending'}
          >
            {customerTold ? t('moment.factCustomerTold') : t('moment.factCustomerNotYet')}
          </li>
        </ol>
      </section>

      <section className={styles.momentCard} data-testid="moment-sent">
        <header className={styles.momentCardHead}>
          <span className={styles.momentDot} aria-hidden="true" />
          <h3 className={styles.momentCardTitle}>{t('moment.sent.title')}</h3>
          <span className={styles.momentCardMeta}>
            {customerTold ? t('moment.sent.delivered') : t('moment.sent.notYet')}
          </span>
        </header>
        <p className={styles.momentMessage}>—</p>
        <div className={styles.momentCardActions}>
          <span className={styles.momentButton} aria-disabled="true">
            {t('moment.sent.add')}
          </span>
          <span className={styles.momentButton} aria-disabled="true">
            {t('moment.sent.discount')}
          </span>
        </div>
      </section>

      {/* After a run of the same kind only: the offer is what a run makes. */}
      {run && run.approved >= 2 ? (
        <section className={styles.momentPattern} data-testid="moment-pattern">
          <div>
            <p className={styles.momentPatternTitle}>
              {t('moment.pattern.title', { count: run.approved })}
            </p>
            <p className={styles.momentPatternBody}>
              {t('moment.pattern.body', { approved: run.approved, rejected: run.rejected })}
            </p>
          </div>
          <div className={styles.momentPatternActions}>
            <span className={styles.momentPatternPrimary} aria-disabled="true">
              {t('moment.pattern.handle')}
            </span>
            <span className={styles.momentPatternSecondary} aria-disabled="true">
              {t('moment.pattern.keep')}
            </span>
          </div>
        </section>
      ) : null}

      <section className={styles.momentNext} data-testid="moment-next">
        {next ? (
          <>
            <div className={styles.momentNextText}>
              <p className={styles.momentNextEyebrow}>{next.eyebrow}</p>
              <p className={styles.momentNextTitle}>
                <UserText>{next.summary}</UserText>
              </p>
              {next.line ? <p className={styles.momentNextLine}>{next.line}</p> : null}
            </div>
            <button
              type="button"
              className={styles.momentOpen}
              data-testid="moment-open-next"
              onClick={onOpenNext}
            >
              {t('moment.next.open')}
            </button>
          </>
        ) : (
          <p className={styles.momentNextLine} data-testid="moment-nothing-next">
            {t('moment.next.none')}
          </p>
        )}
      </section>
    </div>
  );
}
