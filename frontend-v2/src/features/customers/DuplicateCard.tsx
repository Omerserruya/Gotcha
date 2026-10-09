'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { customerLabel, type CustomerRow } from '@/api/contracts/customers';
import { useRouter } from '@/i18n/navigation';

import {
  markNotSame,
  mergeContacts,
  type MergeResult,
  type NotSameResult,
} from './identity-actions';
import styles from './Customers.module.css';

/**
 * 02's "Two accounts look like one person" - suggested, never silent. Merge
 * asks once more, then `POST /api/identity/merge`; nothing happens before
 * that second press. "Not the same" remembers the pair as two people
 * (`POST /api/identity/not-same`) and they are never suggested together
 * again; a merge later still works.
 */
export function DuplicateCard({
  pair,
  unchecked = false,
}: {
  /** Two rows that share a phone or email; `null` when none do. */
  readonly pair: readonly [CustomerRow, CustomerRow] | null;
  /** The marked pairs could not be read, so none is suggested - said, not "no duplicates". */
  readonly unchecked?: boolean;
}) {
  const t = useTranslations('customers.dupes');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [marked, setMarked] = useState<NotSameResult | null>(null);
  const [isPending, startTransition] = useTransition();

  if (pair === null) {
    return (
      <section className={styles.sideCard} data-testid="duplicates">
        <h2 className={styles.sideTitle}>{t('title')}</h2>
        <p className={styles.sideNote} data-testid={unchecked ? 'duplicates-unchecked' : undefined}>
          {unchecked ? t('unchecked') : t('none')}
        </p>
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
      ) : marked?.ok ? (
        <p className={styles.sideNote} role="status" data-testid="not-same-done">
          {t('notSameDone')}
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
              <button
                type="button"
                className={styles.dupeSecondary}
                disabled={isPending}
                data-testid="not-same"
                onClick={() =>
                  startTransition(async () => {
                    setResult(null);
                    const done = await markNotSame(target.id, source.id);
                    setMarked(done);
                    if (done.ok) router.refresh();
                  })
                }
              >
                {t('notSame')}
              </button>
            </>
          )}
        </div>
      )}
      {result && !result.ok ? (
        <p className={styles.dupeProblem} role="alert" data-testid="merge-problem">
          {t(`failed.${result.reason}`)}
        </p>
      ) : null}
      {marked && !marked.ok ? (
        <p className={styles.dupeProblem} role="alert" data-testid="not-same-problem">
          {t(`notSameFailed.${marked.reason}`)}
        </p>
      ) : null}
    </section>
  );
}
