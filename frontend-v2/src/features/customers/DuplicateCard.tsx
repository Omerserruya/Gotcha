'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { labelFromServer } from '@/api/contracts/customers';
import { suggestionMatch, type IdentitySuggestion } from '@/api/contracts/identity';
import { useRouter } from '@/i18n/navigation';

import {
  acceptSuggestion,
  markNotSame,
  type AcceptResult,
  type NotSameResult,
} from './identity-actions';
import { PersonName } from './PersonName';
import styles from './Customers.module.css';

/**
 * 02's "Two accounts look like one person" - a pair the SERVER suggested
 * (`GET /api/identity/suggestions`, Backend 83579ac8); nothing here pairs
 * customers itself. The page draws it only when there is a pair: none, or a
 * failed read, is no card at all.
 *
 * Suggested, never silent. "Merge them" asks once more, then `POST
 * /api/identity/suggestions/accept`; nothing happens before that second
 * press. "Not the same" remembers the pair as two people (`POST
 * /api/identity/not-same`) and the server never suggests them again.
 */
export function DuplicateCard({ suggestion }: { readonly suggestion: IdentitySuggestion }) {
  const t = useTranslations('customers.dupes');
  const list = useTranslations('customers.list');
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AcceptResult | null>(null);
  const [marked, setMarked] = useState<NotSameResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const [a, b] = suggestion.contactIds;
  // The server's labels: a name as written, its fallback words in ours.
  const nameOf = (contact: IdentitySuggestion['contacts'][number]) => {
    const label = labelFromServer(contact.label, contact.channel);
    return 'name' in label ? <PersonName name={label.name} /> : list(`generic.${label.generic}`);
  };

  return (
    <section className={styles.sideCard} data-testid="duplicates">
      <h2 className={styles.sideTitle}>{t('title')}</h2>
      <p className={styles.dupeNames} data-testid="duplicate-pair">
        {suggestion.contacts.map((contact) => (
          <span key={contact.id} data-testid={`duplicate-${contact.id}`}>
            {nameOf(contact)}
          </span>
        ))}
      </p>
      <p className={styles.sideNote}>
        {`${t(`why.${suggestionMatch(suggestion)}`)} ${t('keeps')}`}
      </p>
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
                    const done = await acceptSuggestion(a, b);
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
                    const done = await markNotSame(a, b);
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
