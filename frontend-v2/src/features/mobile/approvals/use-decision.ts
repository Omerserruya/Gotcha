'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { Approval } from '@/api/contracts/approvals';
import { approveRequest, rejectRequest, retryExecution } from '@/features/approvals/actions';
import { useRouter } from '@/i18n/navigation';

/** What happened to a request decided on this screen, held until the page is left. */
export interface Decided {
  readonly approval: Approval;
  readonly outcome: 'ran' | 'didntRun' | 'rejected';
}

/**
 * Approve, reject and retry, as the website's server actions answer them.
 *
 * ★ THE DESKTOP'S STATE MACHINE, NOT A SECOND ONE. A 409 is "someone else
 *   decided, or it lapsed", a 403 is separation of duties, and a rejection
 *   without a reason is refused before it is sent. Approving reports the
 *   DECISION and whether it RAN as two facts, and a failed run can be tried
 *   again here.
 *
 * `refresh`: the list re-reads its queue after a decision; a request's own
 * screen does not, so its outcome stays on it rather than turning into
 * "no longer waiting".
 */
export function useDecision({ refresh }: { readonly refresh: boolean }) {
  const t = useTranslations('approvals');
  const router = useRouter();
  const [decided, setDecided] = useState<readonly Decided[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** A refusal, kept to the request it belongs to. */
  const [problem, setProblem] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  /** Never a silent outcome: every decision is announced. */
  const [announcement, setAnnouncement] = useState('');

  /** A refusal said where it happened; a row that moved under us re-reads the queue. */
  const refused = (id: string, why: string) => {
    setProblem({ id, text: t(`error.${why}` as 'error.stale') });
    setAnnouncement(t(`error.${why}` as 'error.stale'));
    if (why === 'stale') router.refresh();
  };

  async function approve(approval: Approval) {
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
    if (refresh) router.refresh();
  }

  /** True once rejected, so the sheet that asked can close. */
  async function reject(approval: Approval, reason: string): Promise<boolean> {
    if (busyId) return false;
    setBusyId(approval.id);
    setProblem(null);
    const result = await rejectRequest(approval.id, reason);
    setBusyId(null);
    if (!result.ok) {
      refused(approval.id, result.reason);
      return false;
    }
    setAnnouncement(t('announce.rejected', { summary: approval.summary }));
    setDecided((list) => [{ approval, outcome: 'rejected' }, ...list]);
    if (refresh) router.refresh();
    return true;
  }

  async function retry(approval: Approval) {
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

  /** The sentence a decision taken here is reported in. */
  const outcomeText = ({ approval, outcome }: Decided) =>
    outcome === 'rejected'
      ? t('announce.rejected', { summary: approval.summary })
      : outcome === 'ran'
        ? t('announce.approvedAndRan', { summary: approval.summary })
        : t('announce.approvedButFailed', { summary: approval.summary });

  return {
    decided,
    busyId,
    problem,
    announcement,
    approve,
    reject,
    retry,
    outcomeText,
    clearProblem: () => setProblem(null),
  };
}
