'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { customerLabel, type CustomerRow } from '@/api/contracts/customers';
import { useRouter } from '@/i18n/navigation';

import { mergeContacts, type MergeResult } from './identity-actions';
import styles from './Customers.module.css';

/**
 * 02's "Two accounts look like one person" — suggested, never silent. Merge
 * asks once more, then `POST /api/identity/merge`; nothing happens before
 * that second press. "Not the same" has no route to remember it: drawn.
 */
export function DuplicateCard({
  pair,
}: {
  /** Two rows that share a phone or email; `null` when none do. */
  readonly pair: readonly [CustomerRow, CustomerRow] | null;
}) {
  const t = useTranslations('customers.dupes');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (pair === null) {
    return (
      <section className={styles.sideCard} data-testid="duplicates">
        <h2 className={styles.sideTitle}>{t('title')}</h2>
        <p className={styles.sideNote}>{t('none')}</p>
      </section>
    );
  }
  const [target, source] = pair;
  const shared =
    target.phone &&
    source.phone &&
    target.phone.replace(/\D/g, '').slice(-9) === source.phone.replace(/\D/g, '').slice(-9)
      ? 'phone'
      : 'email';

  return (
    <section className={styles.sideCard} data-testid="duplicates">
      <h2 className={styles.sideTitle}>{t('title')}</h2>
      <p className={styles.dupeNames} data-testid="duplicate-pair">
        <span>{customerLabel(target)}</span>
        <span>{customerLabel(source)}</span>
      </p>
      <p className={styles.sideNote}>{t('body', { match: t(`match.${shared}`) })}</p>
      {result?.ok ? (
        <p className={styles.sideNote} role="status" data-testid="merge-done">
          {t('done')}
        </p>
      ) : (
        <div className={styles.dupeActions}>
          {confirming ? (
            <>
              <span className={styles.sideNote}>{t('confirm')}</span>
              <button
                type="button"
                className={styles.dupePrimary}
                disabled={isPending}
                data-testid="merge-confirm"
                onClick={() =>
                  startTransition(async () => {
                    const done = await mergeContacts(target.id, source.id);
                    setResult(done);
                    setConfirming(false);
                    if (done.ok) router.refresh();
                  })
                }
              >
                {t('confirmYes')}
              </button>
              <button
                type="button"
                className={styles.dupeSecondary}
                data-testid="merge-cancel"
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.dupePrimary}
                data-testid="merge"
                onClick={() => {
                  setResult(null);
                  setConfirming(true);
                }}
              >
                {t('merge')}
              </button>
              <span
                className={styles.dupeSecondary}
                aria-disabled="true"
                title={t('notSameNotYet')}
                data-testid="not-same"
              >
                {t('notSame')}
              </span>
            </>
          )}
        </div>
      )}
      {result && !result.ok ? (
        <p className={styles.dupeProblem} role="alert" data-testid="merge-problem">
          {t(`failed.${result.reason}`)}
        </p>
      ) : null}
    </section>
  );
}
