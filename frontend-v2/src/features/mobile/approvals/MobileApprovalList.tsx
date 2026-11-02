'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import {
  humanizeTag,
  isDecidable,
  isKnownRiskTag,
  visibleRiskTags,
  type Approval,
} from '@/api/contracts/approvals';
import { UserText } from '@/design-system/primitives/text/UserText';
import { approveRequest, rejectRequest, retryExecution } from '@/features/approvals/actions';
import {
  PLAN_REJECT_REASONS,
  REJECT_REASONS,
  type RejectReason,
} from '@/features/approvals/ApprovalsScreen';
import { isolated } from '@/features/approvals/isolate';
import {
  approveChain,
  requestTitle,
  reversibilityOf,
  whyBullets,
  type Words,
} from '@/features/approvals/request-words';
import { Link, useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import styles from './mobile-approvals.module.css';
import { amountOf, planAsked, rowClock, spanOf } from './mobile-approvals';

/** What happened to a request decided on this screen, held until the page is left. */
interface Decided {
  readonly approval: Approval;
  readonly outcome: 'ran' | 'didntRun' | 'rejected';
}

/**
 * The waiting requests as phone cards: what is asked, for whom, in which
 * conversation, how long it has waited - and Approve and Reject.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE DESKTOP'S ACTIONS AND THE DESKTOP'S STATES, NOT A SECOND MACHINE
 * ════════════════════════════════════════════════════════════════════════════
 * `approveRequest`, `rejectRequest` and `retryExecution` are the website's
 * server actions, so the guarded state machine is the server's on both: a
 * 409 is "someone else decided, or it lapsed", a 403 is separation of duties,
 * and a rejection without a reason is refused before it is sent. Approving
 * reports the DECISION and whether it RAN as two facts, as 03b does, and a
 * failed run can be tried again here.
 *
 * What stays on the website: editing an amount, Ask GOTCHA, the keyboard and
 * the history. A phone approves a request as it was asked, or rejects it.
 *
 * ⚠ A tap on Approve is the decision. There is no undo anywhere in this
 *   platform, so the card says what approving does before the button.
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
  const t = useTranslations('approvals');
  const m = useTranslations('mobile');
  const locale = useLocale();
  const router = useRouter();

  // The desktop's clock: starts at the server's moment, then ticks.
  const [nowMs, setNowMs] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const [decided, setDecided] = useState<readonly Decided[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [choice, setChoice] = useState<RejectReason | null>(null);
  const [reason, setReason] = useState('');
  /** A refusal, kept to the card it belongs to. */
  const [problem, setProblem] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  /** Never a silent outcome: every decision is announced. */
  const [announcement, setAnnouncement] = useState('');

  const gone = new Set(decided.map((d) => d.approval.id));
  const waiting = pending.filter((approval) => !gone.has(approval.id));

  const say = (words: Words | null, fallback: string) =>
    words
      ? t(`request.${words.key}` as 'request.queueRefund', isolated(words.values) as never)
      : fallback;
  const reasonText = (key: RejectReason) =>
    key === 'wrong'
      ? t('plan.reasons.wrong')
      : key === 'tooGenerous' || key === 'other'
        ? t(`reject3.${key}`)
        : t(`action2.reasons.${key}`);
  const riskLabel = (tag: string) =>
    isKnownRiskTag(tag) ? t(`risk.${tag}` as 'risk.IRREVERSIBLE') : humanizeTag(tag);
  const clock = (iso: string): string | null => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  };
  const span = (ms: number) => {
    const { unit, n } = spanOf(ms);
    return t(`time.${unit}`, { n });
  };
  const askedBy = (approval: Approval): string => {
    const plan = planAsked(approval, viewerId);
    if (plan) return t(plan.key as 'plan.asked.you.unknown', { name: plan.name ?? '' });
    const who = requesters[approval.id];
    if (who) return t('detail.requestedBy', { who });
    return aiAsked.includes(approval.id)
      ? t('detail3.eyebrowAi', { time: clock(approval.createdAt) ?? '' })
      : t('detail.requestedByAutomation');
  };

  const closeReject = () => {
    setRejecting(null);
    setChoice(null);
    setReason('');
  };

  /** A refusal said on its card; a row that moved under us re-reads the queue. */
  const refused = (id: string, why: string) => {
    setProblem({ id, text: t(`error.${why}` as 'error.stale') });
    setAnnouncement(t(`error.${why}` as 'error.stale'));
    if (why === 'stale') router.refresh();
  };

  async function onApprove(approval: Approval) {
    if (busyId) return;
    setBusyId(approval.id);
    setProblem(null);
    const result = await approveRequest(approval.id);
    setBusyId(null);
    if (!result.ok) return refused(approval.id, result.reason);
    // The decision was recorded; whether it RAN is `dispatched`, said apart.
    const ran = result.dispatched !== false;
    setAnnouncement(
      ran
        ? t('announce.approvedAndRan', { summary: approval.summary })
        : t('announce.approvedButFailed', { summary: approval.summary }),
    );
    setDecided((list) => [{ approval, outcome: ran ? 'ran' : 'didntRun' }, ...list]);
    router.refresh();
  }

  async function onReject(approval: Approval) {
    if (busyId) return;
    setBusyId(approval.id);
    setProblem(null);
    const result = await rejectRequest(approval.id, reason);
    setBusyId(null);
    if (!result.ok) return refused(approval.id, result.reason);
    setAnnouncement(t('announce.rejected', { summary: approval.summary }));
    setDecided((list) => [{ approval, outcome: 'rejected' }, ...list]);
    closeReject();
    router.refresh();
  }

  async function onRetry(approval: Approval) {
    if (busyId) return;
    setBusyId(approval.id);
    const result = await retryExecution(approval.id);
    setBusyId(null);
    if (!result.ok) return refused(approval.id, result.reason);
    setAnnouncement(result.dispatched ? t('announce.retryWorked') : t('announce.retryFailedAgain'));
    if (result.dispatched) {
      setDecided((list) =>
        list.map((d) => (d.approval.id === approval.id ? { ...d, outcome: 'ran' } : d)),
      );
    }
  }

  return (
    <>
      <p aria-live="polite" className="srOnly" data-testid="mobile-approvals-announcement">
        {announcement}
      </p>

      {decided.length > 0 ? (
        <ul className={styles.list} data-testid="mobile-approvals-decided">
          {decided.map(({ approval, outcome }) => (
            <li
              key={approval.id}
              className={styles.done}
              data-outcome={outcome}
              data-testid={`mobile-decided-${approval.id}`}
            >
              <p className={styles.doneText}>
                {outcome === 'rejected'
                  ? t('announce.rejected', { summary: approval.summary })
                  : outcome === 'ran'
                    ? t('announce.approvedAndRan', { summary: approval.summary })
                    : t('announce.approvedButFailed', { summary: approval.summary })}
              </p>
              {outcome === 'didntRun' ? (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busyId !== null}
                  onClick={() => void onRetry(approval)}
                  data-testid={`mobile-retry-${approval.id}`}
                >
                  {t('action.retry')}
                </button>
              ) : null}
              {problem?.id === approval.id ? (
                <p className={styles.problem} role="alert">
                  {problem.text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {waiting.length === 0 ? (
        <p className={styles.note} data-testid="mobile-approvals-empty">
          {t('rest.lead')}
        </p>
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
            const tag = approval.plan ? undefined : visibleRiskTags(approval.riskTags)[0];
            const reversible = reversibilityOf(approval.tool);
            const reasons = approval.plan ? PLAN_REJECT_REASONS : REJECT_REASONS;
            const why = approval.plan ? [] : whyBullets(approval.reason);
            const busy = busyId === approval.id;
            return (
              <li
                key={approval.id}
                className={styles.card}
                data-lapsed={decidable ? undefined : ''}
                data-testid={`mobile-approval-${approval.id}`}
              >
                <p className={styles.eyebrow}>
                  <span className={styles.asked}>{askedBy(approval)}</span>
                  <span className={styles.when} data-soon={time.kind === 'waited' ? undefined : ''}>
                    {time.kind === 'lapsed'
                      ? t('queue.lapsed')
                      : time.kind === 'left'
                        ? t('time.left', { in: span(time.ms) })
                        : span(time.ms)}
                  </span>
                </p>

                <h2 className={styles.title}>
                  {say(requestTitle(approval, name, amount), approval.summary)}
                </h2>

                {approval.facts.order || approval.facts.note ? (
                  <p className={styles.facts}>
                    {[
                      approval.facts.order
                        ? t('request.orderLine', { order: approval.facts.order })
                        : null,
                      approval.facts.note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}

                {tag || reversible || approval.conversationId ? (
                  <p className={styles.meta}>
                    {tag ? (
                      <span className={styles.tag} data-tag={tag}>
                        {riskLabel(tag)}
                      </span>
                    ) : null}
                    {reversible ? (
                      <span className={styles.tag} data-testid={`mobile-reversible-${approval.id}`}>
                        {t('detail3.reversible')}:{' '}
                        {reversible === 'yes'
                          ? t('detail3.reversibleYes')
                          : t('detail3.reversibleNo')}
                      </span>
                    ) : null}
                    {approval.conversationId ? (
                      <Link
                        href={`/m/inbox/${approval.conversationId}` as '/m/inbox'}
                        className={styles.conversation}
                        data-testid={`mobile-approval-conversation-${approval.id}`}
                      >
                        {m('approvals.conversation')}
                      </Link>
                    ) : null}
                  </p>
                ) : null}

                {/* What approving does, then why: read before the button, never after. */}
                <details className={styles.more}>
                  <summary className={styles.moreSummary}>{t('chain.title')}</summary>
                  {approval.plan ? (
                    approval.plan.steps.length === 0 ? (
                      <p className={styles.moreText}>{t('plan.noSteps')}</p>
                    ) : (
                      <ol className={styles.steps}>
                        {approval.plan.steps.map((step, i) => (
                          <li key={i} dir="auto">
                            {step.target.conversationId ? (
                              <Link href={`/m/inbox/${step.target.conversationId}` as '/m/inbox'}>
                                {step.summary}
                              </Link>
                            ) : (
                              step.summary
                            )}
                          </li>
                        ))}
                      </ol>
                    )
                  ) : (
                    <ol className={styles.steps}>
                      {approveChain(approval, name, amount).map((step, i) => (
                        <li key={step.key + i}>{say(step, '')}</li>
                      ))}
                    </ol>
                  )}
                  {why.length > 0 || approval.policyRuleName ? (
                    <>
                      <p className={styles.moreHeading}>{t('card.why')}</p>
                      {why.length > 0 ? (
                        <ul className={styles.steps}>
                          {why.map((line, i) => (
                            <li key={i}>
                              <UserText>{line}</UserText>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {approval.policyRuleName ? (
                        <p className={styles.moreText}>
                          {t('detail.policyRule', { rule: approval.policyRuleName })}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </details>

                {!decidable ? (
                  // Past its deadline: the route answers 409, so no decision is offered.
                  <p className={styles.lapsed} data-testid={`mobile-lapsed-${approval.id}`}>
                    {t('detail.lapsed')}
                  </p>
                ) : rejecting === approval.id ? (
                  /* The desktop's closed choice, and "Other" to type one. Reject waits for it. */
                  <div className={styles.reject} role="group" aria-label={t('reject3.prompt')}>
                    <p className={styles.rejectPrompt}>{t('reject3.prompt')}</p>
                    <div className={styles.reasons}>
                      {reasons.map((key) => (
                        <button
                          key={key}
                          type="button"
                          className={styles.reason}
                          aria-pressed={choice === key}
                          data-testid={`mobile-reason-${key}`}
                          onClick={() => {
                            setChoice(key);
                            setReason(key === 'other' ? '' : reasonText(key));
                          }}
                        >
                          {reasonText(key)}
                        </button>
                      ))}
                    </div>
                    {choice === 'other' ? (
                      <input
                        className={styles.reasonInput}
                        value={reason}
                        dir={typedDir(reason)}
                        aria-label={t('reject3.otherLabel')}
                        placeholder={t('reject3.otherLabel')}
                        onChange={(event) => setReason(event.target.value)}
                        data-testid="mobile-reject-reason"
                      />
                    ) : null}
                    <div className={styles.buttons}>
                      <button type="button" className={styles.secondary} onClick={closeReject}>
                        {m('approvals.cancel')}
                      </button>
                      <button
                        type="button"
                        className={styles.rejectButton}
                        disabled={busy || reason.trim() === ''}
                        onClick={() => void onReject(approval)}
                        data-testid={`mobile-reject-confirm-${approval.id}`}
                      >
                        {t('action.reject')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.buttons}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busyId !== null}
                      onClick={() => {
                        closeReject();
                        setProblem(null);
                        setRejecting(approval.id);
                      }}
                      data-testid={`mobile-reject-${approval.id}`}
                    >
                      {t('action.reject')}
                    </button>
                    <button
                      type="button"
                      className={styles.approve}
                      disabled={busyId !== null}
                      aria-busy={busy}
                      onClick={() => void onApprove(approval)}
                      data-testid={`mobile-approve-${approval.id}`}
                    >
                      {t('action.approve')}
                    </button>
                  </div>
                )}

                {problem?.id === approval.id ? (
                  <p
                    className={styles.problem}
                    role="alert"
                    data-testid={`mobile-problem-${approval.id}`}
                  >
                    {problem.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
