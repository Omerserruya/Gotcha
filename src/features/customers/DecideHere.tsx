'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { approveRequest, rejectRequest } from '@/features/approvals/actions';
import { Link, useRouter } from '@/i18n/navigation';

import styles from './Customers.module.css';

/**
 * 04e's pending action, decided where it is read — 02's "Approve · Decline ·
 * Change amount". The same writes as 03, and they ask first: an approval
 * moves money. Approve says what HAPPENED, not only that it was recorded —
 * a decision can land and the action still not run. Decline takes 03's own
 * reasons, sent as their label as 03 sends them. Changing the amount is 03's
 * editor: it opens there.
 */
export function DecideHere({ approvalId }: { readonly approvalId: string }) {
  const t = useTranslations('customers.actions.decide');
  const ta = useTranslations('approvals');
  const router = useRouter();
  const [asking, setAsking] = useState<'approve' | 'decline' | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  if (said?.ok) {
    return (
      <span className={styles.decideSaid} role="status" data-testid={`decided-here-${approvalId}`}>
        {said.text}
      </span>
    );
  }

  const approve = () =>
    startTransition(async () => {
      const done = await approveRequest(approvalId);
      setAsking(null);
      if (done.ok) {
        setSaid({ ok: true, text: done.dispatched ? t('approvedRan') : t('approvedNotRun') });
        router.refresh();
      } else
        setSaid({
          ok: false,
          text: t(
            `refused.${done.reason === 'stale' ? 'stale' : done.reason === 'forbidden' ? 'forbidden' : 'failed'}`,
          ),
        });
    });
  const decline = (reason: string) =>
    startTransition(async () => {
      const done = await rejectRequest(approvalId, reason);
      setAsking(null);
      if (done.ok) {
        setSaid({ ok: true, text: t('declined') });
        router.refresh();
      } else
        setSaid({
          ok: false,
          text: t(
            `refused.${done.reason === 'stale' ? 'stale' : done.reason === 'forbidden' ? 'forbidden' : 'failed'}`,
          ),
        });
    });

  return (
    <span className={styles.decideRow} data-testid={`decide-here-${approvalId}`}>
      {asking === 'approve' ? (
        <>
          <span>{t('approveAsk')}</span>
          <button
            type="button"
            className={styles.decidePrimary}
            disabled={isPending}
            data-testid={`decide-yes-${approvalId}`}
            onClick={approve}
          >
            {t('approveYes')}
          </button>
          <button type="button" className={styles.decideQuiet} onClick={() => setAsking(null)}>
            {t('notNow')}
          </button>
        </>
      ) : asking === 'decline' ? (
        <>
          <span>{t('declineAsk')}</span>
          {(['policy', 'myself', 'wrongOrder'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={styles.decideQuiet}
              disabled={isPending}
              data-testid={`decide-reason-${key}-${approvalId}`}
              onClick={() => decline(ta(`action2.reasons.${key}`))}
            >
              {ta(`action2.reasons.${key}`)}
            </button>
          ))}
          <button type="button" className={styles.decideQuiet} onClick={() => setAsking(null)}>
            {t('notNow')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={styles.decidePrimary}
            data-testid={`decide-approve-${approvalId}`}
            onClick={() => {
              setSaid(null);
              setAsking('approve');
            }}
          >
            {t('approve')}
          </button>
          <button
            type="button"
            className={styles.decideQuiet}
            data-testid={`decide-decline-${approvalId}`}
            onClick={() => {
              setSaid(null);
              setAsking('decline');
            }}
          >
            {t('decline')}
          </button>
          <Link href="/approvals" className={styles.actionDecide}>
            {t('changeAmount')}
          </Link>
          {said && !said.ok ? (
            <span className={styles.decideProblem} role="alert">
              {said.text}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}
