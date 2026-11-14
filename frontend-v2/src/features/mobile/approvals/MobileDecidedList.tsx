import { useLocale, useTranslations } from 'next-intl';

import type { Approval } from '@/api/contracts/approvals';
import { isolated } from '@/features/approvals/isolate';
import { queueTitle } from '@/features/approvals/request-words';

import ui from '../mobile-ui.module.css';
import styles from './mobile-approvals.module.css';
import { amountOf, decidedOutcome, type DecidedOutcome } from './mobile-approvals';

const TONE: Record<DecidedOutcome, 'ok' | 'warn' | 'mute'> = {
  ran: 'ok',
  approved: 'ok',
  didntRun: 'warn',
  rejected: 'mute',
};

/**
 * "Decided today", one card of rows: what it was, for whom, and what it came
 * to - and of an approval, whether it ran, never one green tick for both.
 */
export function MobileDecidedList({
  decided,
  customerNames,
}: {
  /** Today's decisions, newest first. `null`: the history could not be read. */
  readonly decided: readonly Approval[] | null;
  readonly customerNames: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('approvals');
  const m = useTranslations('mobile.approvals');
  const locale = useLocale();

  if (decided === null) {
    return (
      <p className={ui.empty} role="status" data-testid="mobile-decided-unavailable">
        {m('decidedUnavailable')}
      </p>
    );
  }
  if (decided.length === 0) {
    return (
      <p className={ui.empty} data-testid="mobile-decided-empty">
        {m('decidedNone')}
      </p>
    );
  }
  return (
    <ul className={styles.decidedCard} data-testid="mobile-decided-list">
      {decided.map((approval) => {
        const words = queueTitle(approval, amountOf(approval, locale));
        const outcome = decidedOutcome(approval);
        const who = [
          customerNames[approval.id] ?? null,
          approval.facts.order ? t('request.orderLine', { order: approval.facts.order }) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={approval.id} className={styles.decidedRow} data-outcome={outcome}>
            <span className={styles.decidedBody}>
              <span className={styles.decidedTitle}>
                {words
                  ? t(
                      `request.${words.key}` as 'request.queueRefund',
                      isolated(words.values) as never,
                    )
                  : approval.summary}
              </span>
              {who ? <span className={styles.decidedWho}>{who}</span> : null}
            </span>
            <span className={ui.tag} data-tone={TONE[outcome]}>
              {m(`outcome.${outcome}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
