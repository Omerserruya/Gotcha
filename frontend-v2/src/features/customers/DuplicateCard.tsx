'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import { labelFromServer } from '@/api/contracts/customers';
import {
  suggestionMatch,
  type IdentitySuggestion,
  type SuggestionEvidence,
} from '@/api/contracts/identity';
import { channelName } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { Link, useRouter } from '@/i18n/navigation';
import { ltr } from '@/lib/bidi';

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
 * Each name carries its channel's mark and opens that customer
 * (`/customers/<contactId>`). Under the reason, the proof the server gave
 * (Backend 3ac2a71e): the two names, the masked phone or email as sent, or
 * the Shopify profile update that verified it. No proof, or a kind this app
 * has no words for, is the reason line alone.
 *
 * Suggested, never silent. "Merge them" asks once more, then `POST
 * /api/identity/suggestions/accept`; nothing happens before that second
 * press. "Not the same" remembers the pair as two people (`POST
 * /api/identity/not-same`) and the server never suggests them again.
 */
export function DuplicateCard({ suggestion }: { readonly suggestion: IdentitySuggestion }) {
  const t = useTranslations('customers.dupes');
  const list = useTranslations('customers.list');
  const channels = useTranslations('channels');
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
          <Link
            key={contact.id}
            className={styles.dupeName}
            href={`/customers/${contact.contactId ?? contact.id}`}
            data-testid={`duplicate-${contact.id}`}
          >
            {/* The channel is said nowhere else on the card: the mark names it. */}
            {contact.channel ? (
              <ChannelPlate
                channel={contact.channel}
                size="sm"
                label={channelName(contact.channel, channels) ?? channels('name.other')}
              />
            ) : null}
            <span>{nameOf(contact)}</span>
          </Link>
        ))}
      </p>
      <p className={styles.dupeWhy}>{t(`why.${suggestionMatch(suggestion)}`)}</p>
      {suggestion.evidence ? <Proof evidence={suggestion.evidence} /> : null}
      <p className={styles.sideNote}>{t('keeps')}</p>
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

/**
 * The server's proof for the pair, as sent. A phone or an email is already
 * masked (`+972 5X-XXX-3421`, `o***@gmail.com`); it is only isolated, so a
 * Hebrew line does not reverse its digits. Names are the customers' own text.
 * A proof with nothing to say - a missing name, a Shopify proof of a kind we
 * have no words for - is no line at all, never a dash or a blank.
 */
export function Proof({ evidence }: { readonly evidence: SuggestionEvidence }) {
  const t = useTranslations('customers.dupes.evidence');
  let line: ReactNode = null;
  if (evidence.type === 'name') {
    const [first, second] = evidence.names;
    if (first && second) {
      line = t.rich('name', {
        first: () => <PersonName name={first} />,
        second: () => <PersonName name={second} />,
      });
    }
  } else if (evidence.type === 'phone' || evidence.type === 'email') {
    line = t(evidence.type, { value: ltr(evidence.value) });
  } else if (
    evidence.type === 'shopify_customer' &&
    evidence.provenBy === 'verified_profile_update'
  ) {
    line = t('shopifyProfile');
  }
  return line ? (
    <p className={styles.dupeProof} data-testid="duplicate-proof" data-evidence={evidence.type}>
      {line}
    </p>
  ) : null;
}
