'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { isDecidable, type Approval } from '@/api/contracts/approvals';
import { UserText } from '@/design-system/primitives/text/UserText';
import type { ApprovalCustomer } from '@/features/approvals/approval-customers';
import { PLAN_REJECT_REASONS, REJECT_REASONS } from '@/features/approvals/ApprovalsScreen';
import { approveChain, requestTitle, whyBullets } from '@/features/approvals/request-words';
import { Link } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-approvals.module.css';
import { amountOf } from './mobile-approvals';
import { RejectSheet } from './RejectSheet';
import { useApprovalWords } from './use-approval-words';
import { useDecision } from './use-decision';

/**
 * One request, full screen - the design's detail: who asked, the request in
 * large type, why GOTCHA recommends it, what approving does step by step, the
 * customer, what leaving it costs, and the decision at the bottom.
 *
 * ★ ONLY WHAT THE REQUEST CARRIES. Each card is drawn from a field the
 *   platform holds - `reason`, the tool's own chain, the customer reads, the
 *   deadline - and a card with nothing to say is not drawn. The design's
 *   per-reason tone is not in `reason`, so every point takes one dot.
 *
 * ★ A decision here stays here: the screen says what it came to, and a
 *   failed run can be tried again, instead of re-reading into "no longer
 *   waiting".
 */
export function MobileApprovalDetail({
  approval,
  customer,
  requesters,
  aiAsked,
  viewerId,
  serverNow,
  editHref,
}: {
  readonly approval: Approval;
  /** The customer reads, every fact `null` where unknown; `null` when none was read. */
  readonly customer: ApprovalCustomer | null;
  readonly requesters: Readonly<Record<string, string>>;
  readonly aiAsked: readonly string[];
  readonly viewerId: string | null;
  readonly serverNow: number;
  /** The website's own detail, where an amount can be edited; `null` where nothing can. */
  readonly editHref: string | null;
}) {
  const m = useTranslations('mobile.approvals');
  const { t, locale, say, reasonText, clock, askedBy } = useApprovalWords({
    requesters,
    aiAsked,
    viewerId,
  });
  const decision = useDecision({ refresh: false });
  const [rejecting, setRejecting] = useState(false);

  const [nowMs, setNowMs] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const name = customer?.name ?? null;
  const amount = amountOf(approval, locale);
  const decidable = isDecidable(approval, now);
  const done = decision.decided.find((d) => d.approval.id === approval.id) ?? null;
  // A plan's `reason` is "Matan asked GOTCHA in Home" - the eyebrow says it already.
  const why = approval.plan ? [] : whyBullets(approval.reason);
  const expires = clock(approval.expiresAt);

  const facts: { readonly key: string; readonly label: string; readonly value: string }[] = [];
  if (customer?.since) {
    facts.push({
      key: 'since',
      label: t('customer.since'),
      value: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
        new Date(customer.since),
      ),
    });
  }
  if (customer?.lifetime) {
    facts.push({
      key: 'orders',
      label: t('customer.orders'),
      value: t('customer.lifetime', {
        amount: new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: customer.lifetime.currency,
          maximumFractionDigits: 0,
        }).format(customer.lifetime.amount),
      }),
    });
  }
  if (customer?.refunds != null) {
    facts.push({
      key: 'refunds',
      label: t('customer.refunds'),
      value: customer.refunds === 0 ? t('customer.refundsNone') : String(customer.refunds),
    });
  }
  if (customer?.mood) facts.push({ key: 'mood', label: t('customer.mood'), value: customer.mood });

  // A plan's step links to the conversation it acts on, as the old card did.
  const steps: readonly { readonly text: string; readonly conversationId?: string }[] =
    approval.plan
      ? approval.plan.steps.map((step) => ({
          text: step.summary,
          conversationId: step.target.conversationId,
        }))
      : approveChain(approval, name, amount).map((step) => ({ text: say(step, '') }));

  return (
    <>
      <p aria-live="polite" className="srOnly" data-testid="mobile-approvals-announcement">
        {decision.announcement}
      </p>

      <div className={styles.detailScroll} data-testid="mobile-approval-detail">
        <div className={styles.detailHead}>
          <p className={styles.detailBy} data-testid="mobile-requested-by">
            {askedBy(approval, true)}
          </p>
          <h1 className={styles.detailTitle}>
            {say(requestTitle(approval, name, amount), approval.summary)}
          </h1>
          {approval.facts.order || approval.facts.note ? (
            <p className={styles.detailSub}>
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
        </div>

        {why.length > 0 || (!approval.plan && approval.policyRuleName) ? (
          <section className={styles.detailCard}>
            <h2 className={ui.cardTitle}>{t('card.why')}</h2>
            {why.length > 0 ? (
              <ul className={styles.why} data-testid="mobile-approval-reason">
                {why.map((line, i) => (
                  <li key={i} className={styles.whyItem}>
                    <span className={styles.dot} aria-hidden="true" />
                    <UserText>{line}</UserText>
                  </li>
                ))}
              </ul>
            ) : null}
            {approval.policyRuleName ? (
              <p className={styles.policyRule}>
                {t('detail.policyRule', { rule: approval.policyRuleName })}
              </p>
            ) : null}
          </section>
        ) : null}

        <section
          className={`${styles.detailCard} ${styles.stepsCard}`}
          data-testid="mobile-approve-chain"
        >
          <h2 className={ui.cardTitle}>{t('chain.title')}</h2>
          {steps.length === 0 ? (
            <p className={styles.policyRule}>{t('plan.noSteps')}</p>
          ) : (
            <ol className={styles.steps}>
              {steps.map((step, i) => (
                <li key={i} className={styles.step} dir={approval.plan ? 'auto' : undefined}>
                  <span className={styles.stepRail} aria-hidden="true">
                    <span className={styles.stepNumber}>{i + 1}</span>
                    {i < steps.length - 1 ? <span className={styles.stepLine} /> : null}
                  </span>
                  <span className={styles.stepText}>
                    {step.conversationId ? (
                      <Link href={`/m/inbox/${step.conversationId}` as '/m/inbox'}>
                        {step.text}
                      </Link>
                    ) : (
                      step.text
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {facts.length > 0 ? (
          <section className={styles.detailCard} data-testid="mobile-customer-card">
            <h2 className={ui.cardTitle}>{t('customer.title')}</h2>
            <dl className={styles.facts}>
              {facts.map((fact) => (
                <div key={fact.key} className={styles.fact}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {decidable && expires ? (
          <section className={styles.leave} data-testid="mobile-if-you-leave-it">
            <h2 className={ui.cardTitle}>{t('card.leave')}</h2>
            <p className={styles.leaveBody}>
              {approval.plan
                ? t('plan.leaveBody', { when: expires })
                : t('card.leaveBody', { when: expires })}
            </p>
          </section>
        ) : null}
      </div>

      <div className={styles.actionBar}>
        {done ? (
          <div className={styles.outcome} data-outcome={done.outcome} data-testid="mobile-outcome">
            <p className={styles.doneText}>{decision.outcomeText(done)}</p>
            <div className={styles.outcomeButtons}>
              {done.outcome === 'didntRun' ? (
                <button
                  type="button"
                  className={ui.secondary}
                  disabled={decision.busyId !== null}
                  onClick={() => void decision.retry(approval)}
                  data-testid={`mobile-retry-${approval.id}`}
                >
                  {t('action.retry')}
                </button>
              ) : null}
              <Link href="/m/approvals" className={ui.primary}>
                {m('back')}
              </Link>
            </div>
          </div>
        ) : !decidable ? (
          // Past its deadline: the route answers 409, so no decision is offered.
          <p className={styles.lapsed} data-testid={`mobile-lapsed-${approval.id}`}>
            {t('detail.lapsed')}
          </p>
        ) : (
          <div className={styles.barButtons}>
            <button
              type="button"
              className={`${ui.primary} ${styles.barApprove}`}
              disabled={decision.busyId !== null}
              aria-busy={decision.busyId === approval.id}
              onClick={() => void decision.approve(approval)}
              data-testid={`mobile-approve-${approval.id}`}
            >
              <Check size={18} strokeWidth={2} aria-hidden="true" />
              {t('action.approve')}
            </button>
            {editHref ? (
              <a href={editHref} className={`${ui.secondary} ${styles.barSecondary}`}>
                {m('editOnWebsite')}
              </a>
            ) : approval.conversationId ? (
              <Link
                href={`/m/inbox/${approval.conversationId}` as '/m/inbox'}
                className={`${ui.secondary} ${styles.barSecondary}`}
                data-testid={`mobile-approval-conversation-${approval.id}`}
              >
                {m('conversation')}
              </Link>
            ) : null}
            <button
              type="button"
              className={`${ui.quiet} ${styles.barQuiet}`}
              disabled={decision.busyId !== null}
              onClick={() => {
                decision.clearProblem();
                setRejecting(true);
              }}
              data-testid={`mobile-reject-${approval.id}`}
            >
              {t('action.reject')}
            </button>
          </div>
        )}
        {decision.problem && !rejecting ? (
          <p className={styles.problem} role="alert" data-testid={`mobile-problem-${approval.id}`}>
            {decision.problem.text}
          </p>
        ) : null}
      </div>

      <RejectSheet
        open={rejecting}
        onOpenChange={setRejecting}
        reasons={approval.plan ? PLAN_REJECT_REASONS : REJECT_REASONS}
        reasonText={reasonText}
        busy={decision.busyId !== null}
        problem={rejecting ? (decision.problem?.text ?? null) : null}
        onReject={(reason) => {
          void decision.reject(approval, reason).then((ok) => (ok ? setRejecting(false) : null));
        }}
      />
    </>
  );
}
