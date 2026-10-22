'use client';

import { useEffect, useState, useTransition } from 'react';

import type { ProposalBlock, ProposalState } from '@/api/contracts/assistant-threads';
import { Link } from '@/i18n/navigation';

import { approveRequest } from '../approvals/actions';
import { stepHref } from '../approvals/step-href';
import styles from './HomeConversation.module.css';
import { readProposalState } from './proposal-state';
import { useTurnTranslations } from './turn-words';

interface Said {
  readonly tone: 'note' | 'problem';
  readonly key: 'ran' | 'notRun' | 'refused.stale' | 'refused.forbidden' | 'refused.failed';
}

/**
 * ★★ Design 7 stage 3 - "N changes ready, nothing is live yet" (Omer via the
 * supervisor, 2026-10-09), on Backend's `proposal` block (26b04e52).
 *
 * A plan the assistant proposed is ONE approval request. This card decides it
 * through the very route Approvals uses (`approveRequest` →
 * `POST /api/approvals/:id/approve`): same permission, same refusals - never a
 * second path. "Edit" is Approvals itself, on this request.
 *
 * ★ Approve asks first, and the question is what will run: each step, in the
 *   plan's own words. Nothing runs on the first press.
 * ★ The request can be decided elsewhere (Approvals, WhatsApp, a colleague)
 *   or expire. The thread's read carries the state at that moment; while the
 *   card is open it re-reads on focus, so it never offers a decision that was
 *   already made.
 *
 * Not drawn (Omer's product question, not built): approving steps one by one,
 * a per-step permission level, a preview, undo.
 */
export function ProposalCard({ proposal }: { readonly proposal: ProposalBlock }) {
  const t = useTurnTranslations('home.conversation.proposal');
  const id = proposal.approvalRequestId;
  /*
   * What this card learned since the thread was read (a decision here, or a
   * re-read). It holds only while the thread still says what it said then: a
   * newer read of the thread wins.
   */
  const [learned, setLearned] = useState<{
    readonly over: ProposalState;
    readonly state: ProposalState;
  } | null>(null);
  const state = learned && learned.over === proposal.state ? learned.state : proposal.state;
  const setState = (next: ProposalState) => setLearned({ over: proposal.state, state: next });
  const [confirming, setConfirming] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [isPending, startTransition] = useTransition();

  const open = state === 'pending' || state === 'approved';
  const read = proposal.state;
  useEffect(() => {
    if (!open) return;
    const reread = () => {
      if (document.visibilityState !== 'visible') return;
      void readProposalState(id).then((next) => {
        if (next) setLearned({ over: read, state: next });
      });
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', reread);
    return () => {
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', reread);
    };
  }, [id, open, read]);

  // Decided elsewhere while asking: the question is no longer one to ask.
  const asking = confirming && state === 'pending';
  const steps =
    proposal.steps.length > 0 ? proposal.steps : [{ summary: proposal.summary, target: null }];

  const approve = () =>
    startTransition(async () => {
      const result = await approveRequest(id);
      setConfirming(false);
      if (result.ok) {
        // The decision is recorded; whether it RAN is `dispatched`.
        setState(result.dispatched ? 'executed' : 'approved');
        setSaid(
          result.dispatched ? { tone: 'note', key: 'ran' } : { tone: 'problem', key: 'notRun' },
        );
        return;
      }
      if (result.reason === 'stale') {
        const next = await readProposalState(id);
        if (next) setState(next);
      }
      setSaid({
        tone: 'problem',
        key:
          result.reason === 'stale'
            ? 'refused.stale'
            : result.reason === 'forbidden'
              ? 'refused.forbidden'
              : 'refused.failed',
      });
    });

  return (
    <section
      className={styles.proposal}
      data-state={state}
      aria-labelledby={`proposal-${id}-head`}
      data-testid={`proposal-${id}`}
    >
      <header className={styles.blockHead}>
        <h3 className={styles.blockTitle} id={`proposal-${id}-head`} data-testid="proposal-head">
          {state === 'pending' ? t('ready', { count: steps.length }) : t(`state.${state}`)}
        </h3>
        {state === 'pending' ? <span className={styles.blockMeta}>{t('notLive')}</span> : null}
      </header>

      <ol className={styles.proposalSteps}>
        {steps.map((step, i) => {
          const href = step.target ? stepHref(step.target) : null;
          return (
            <li key={i} className={styles.proposalStep}>
              <span dir="auto">{step.summary}</span>
              {href ? (
                <Link
                  href={href}
                  className={styles.stepLink}
                  data-testid={`proposal-${id}-step-${i}`}
                >
                  {t('open')}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>

      {asking ? (
        <div className={styles.proposalConfirm} role="group" data-testid="proposal-confirm">
          <p className={styles.proposalAsk}>{t('confirm.ask', { count: steps.length })}</p>
          <ol className={styles.proposalRun}>
            {steps.map((step, i) => (
              <li key={i} dir="auto">
                {step.summary}
              </li>
            ))}
          </ol>
          <p className={styles.proposalActions}>
            <button
              type="button"
              className={styles.proposalGo}
              disabled={isPending}
              data-testid="proposal-yes"
              onClick={approve}
            >
              {t('confirm.yes')}
            </button>
            <button
              type="button"
              className={styles.proposalQuiet}
              disabled={isPending}
              data-testid="proposal-back"
              onClick={() => setConfirming(false)}
            >
              {t('confirm.back')}
            </button>
          </p>
        </div>
      ) : state === 'pending' ? (
        <p className={styles.proposalActions}>
          <button
            type="button"
            className={styles.proposalGo}
            data-testid="proposal-approve"
            onClick={() => {
              setSaid(null);
              setConfirming(true);
            }}
          >
            {t('approve')}
          </button>
          <Link
            href={{ pathname: '/approvals', query: { id } }}
            className={styles.proposalQuiet}
            data-testid="proposal-edit"
          >
            {t('edit')}
          </Link>
        </p>
      ) : state === 'approved' ? (
        // Decided, not (yet) run: where it runs again, or says why it did not.
        <p className={styles.proposalActions}>
          <Link
            href={{ pathname: '/approvals', query: { id } }}
            className={styles.proposalQuiet}
            data-testid="proposal-open"
          >
            {t('openRequest')}
          </Link>
        </p>
      ) : null}

      {said ? (
        <p
          className={said.tone === 'note' ? styles.note : styles.problem}
          role={said.tone === 'note' ? 'status' : 'alert'}
          data-testid="proposal-said"
        >
          {t(said.key)}
        </p>
      ) : null}
    </section>
  );
}
