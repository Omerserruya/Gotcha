'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { isDecidable, visibleRiskTags, type Approval } from '@/api/contracts/approvals';
import { PLAN_REJECT_REASONS, REJECT_REASONS } from '@/features/approvals/ApprovalsScreen';
import { queueTitle } from '@/features/approvals/request-words';
import { Link } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-approvals.module.css';
import { amountOf, isUrgent, rowClock, tagTone } from './mobile-approvals';
import { RejectSheet } from './RejectSheet';
import { useApprovalWords } from './use-approval-words';
import { useDecision } from './use-decision';

/**
 * The waiting requests as the design's cards: what is asked and for whom, how
 * long it has waited, one tag - and Approve, Details and Reject.
 *
 * ★ THE DESKTOP'S ACTIONS (`useDecision`), so the phone refuses what the
 *   website refuses. Editing an amount and the history stay on the website.
 *
 * ⚠ A tap on Approve is the decision. There is no undo anywhere in this
 *   platform; Details says what approving does before the button.
 */
export function MobileApprovalList({
  pending,
  requesters,
  aiAsked,
  customerNames,
  serverNow,
  viewerId,
}: {
  readonly pending: readonly Approval[];
  /** `id → who asked`, resolved on the server so no cuid reaches the phone. */
  readonly requesters: Readonly<Record<string, string>>;
  /** Requests an AI asked for whose employee cannot be named. */
  readonly aiAsked: readonly string[];
  /** `id → the customer's name`, where the conversation names one. */
  readonly customerNames: Readonly<Record<string, string>>;
  /** Epoch ms the queue was read at, so the first client render matches the server's. */
  readonly serverNow: number;
  readonly viewerId: string | null;
}) {
  const m = useTranslations('mobile.approvals');
  const { t, locale, say, reasonText, riskLabel, timeText, askedBy } = useApprovalWords({
    requesters,
    aiAsked,
    viewerId,
  });
  const decision = useDecision({ refresh: true });

  // The desktop's clock: starts at the server's moment, then ticks.
  const [nowMs, setNowMs] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const [rejecting, setRejecting] = useState<Approval | null>(null);

  const gone = new Set(decision.decided.map((d) => d.approval.id));
  const waiting = pending.filter((approval) => !gone.has(approval.id));

  return (
    <>
      <p aria-live="polite" className="srOnly" data-testid="mobile-approvals-announcement">
        {decision.announcement}
      </p>

      <div className={styles.cards}>
        {/* Decided here, said as two facts: the decision, and whether it ran. */}
        {decision.decided.map((done) => (
          <div
            key={done.approval.id}
            className={styles.done}
            data-outcome={done.outcome}
            data-testid={`mobile-decided-${done.approval.id}`}
          >
            <p className={styles.doneText}>{decision.outcomeText(done)}</p>
            {done.outcome === 'didntRun' ? (
              <button
                type="button"
                className={ui.secondary}
                disabled={decision.busyId !== null}
                onClick={() => void decision.retry(done.approval)}
                data-testid={`mobile-retry-${done.approval.id}`}
              >
                {t('action.retry')}
              </button>
            ) : null}
            {decision.problem?.id === done.approval.id ? (
              <p className={styles.problem} role="alert">
                {decision.problem.text}
              </p>
            ) : null}
          </div>
        ))}

        {waiting.length === 0 ? (
          <div className={ui.empty} data-testid="mobile-approvals-empty">
            <span className={styles.emptyDisc} aria-hidden="true">
              <Check size={26} strokeWidth={2} />
            </span>
            <span className={ui.emptyTitle}>{m('emptyTitle')}</span>
            <span className={styles.emptyBody}>{m('emptyBody')}</span>
          </div>
        ) : (
          <ul
            className={styles.list}
            data-testid="mobile-approvals-list"
            aria-label={t('queue.label')}
          >
            {waiting.map((approval) => {
              const name = customerNames[approval.id] ?? null;
              const amount = amountOf(approval, locale);
              const time = rowClock(approval, now);
              const decidable = isDecidable(approval, now);
              const risk = approval.plan ? undefined : visibleRiskTags(approval.riskTags)[0];
              const tag = approval.plan?.source
                ? { label: t(`plan.chip.${approval.plan.source}`), tone: 'ai' as const }
                : risk
                  ? { label: riskLabel(risk), tone: tagTone(risk) }
                  : null;
              const who =
                [
                  name,
                  approval.facts.order
                    ? t('request.orderLine', { order: approval.facts.order })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || askedBy(approval);
              const href = `/m/approvals/${approval.id}` as '/m/approvals';
              const busy = decision.busyId === approval.id;
              return (
                <li
                  key={approval.id}
                  className={styles.card}
                  data-lapsed={decidable ? undefined : ''}
                  data-testid={`mobile-approval-${approval.id}`}
                >
                  <Link href={href} className={styles.cardHead}>
                    <div className={styles.cardTop}>
                      <h2 className={styles.cardTitle}>
                        {say(queueTitle(approval, amount), approval.summary)}
                      </h2>
                      <span className={styles.time} data-urgent={isUrgent(time) ? '' : undefined}>
                        {timeText(time)}
                      </span>
                    </div>
                    <span className={styles.who}>{who}</span>
                    {tag ? (
                      <span className={styles.cardTags}>
                        <span className={ui.tag} data-tone={tag.tone} data-tag={risk}>
                          {tag.label}
                        </span>
                      </span>
                    ) : null}
                  </Link>

                  {!decidable ? (
                    // Past its deadline: the route answers 409, so no decision is offered.
                    <p className={styles.lapsed} data-testid={`mobile-lapsed-${approval.id}`}>
                      {t('detail.lapsed')}
                    </p>
                  ) : (
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={`${ui.primary} ${styles.approve}`}
                        disabled={decision.busyId !== null}
                        aria-busy={busy}
                        onClick={() => void decision.approve(approval)}
                        data-testid={`mobile-approve-${approval.id}`}
                      >
                        <Check size={17} strokeWidth={2} aria-hidden="true" />
                        {t('action.approve')}
                      </button>
                      <Link
                        href={href}
                        className={ui.secondary}
                        data-testid={`mobile-details-${approval.id}`}
                      >
                        {m('details')}
                      </Link>
                      <button
                        type="button"
                        className={ui.quiet}
                        disabled={decision.busyId !== null}
                        onClick={() => {
                          decision.clearProblem();
                          setRejecting(approval);
                        }}
                        data-testid={`mobile-reject-${approval.id}`}
                      >
                        {t('action.reject')}
                      </button>
                    </div>
                  )}

                  {decision.problem?.id === approval.id && rejecting === null ? (
                    <p
                      className={styles.problem}
                      role="alert"
                      data-testid={`mobile-problem-${approval.id}`}
                    >
                      {decision.problem.text}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <RejectSheet
        open={rejecting !== null}
        onOpenChange={(open) => (open ? null : setRejecting(null))}
        reasons={rejecting?.plan ? PLAN_REJECT_REASONS : REJECT_REASONS}
        reasonText={reasonText}
        busy={decision.busyId !== null}
        problem={rejecting && decision.problem?.id === rejecting.id ? decision.problem.text : null}
        onReject={(reason) => {
          if (!rejecting) return;
          void decision.reject(rejecting, reason).then((ok) => (ok ? setRejecting(null) : null));
        }}
      />
    </>
  );
}
