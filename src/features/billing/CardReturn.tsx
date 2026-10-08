'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Link } from '@/i18n/navigation';

import { confirmCardSession, type CardConfirmResult } from './actions';
import { CARD_SESSION_KEY } from './card-session';
import styles from './Billing.module.css';

type Shown =
  | { readonly kind: 'checking' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'none' }
  | { readonly kind: 'answer'; readonly result: CardConfirmResult };

/**
 * Back from the provider's hosted page: did a card arrive? The session id was
 * kept in sessionStorage by Add / Replace card; the provider is asked once on
 * arrival, and again only when the person presses Check again.
 */
export function CardReturn({ cancelled }: { readonly cancelled: boolean }) {
  const t = useTranslations('billing.card');
  const [shown, setShown] = useState<Shown>({ kind: 'checking' });
  const asked = useRef(false);

  const check = async () => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(CARD_SESSION_KEY);
    } catch {
      id = null;
    }
    if (!id) {
      setShown({ kind: 'none' });
      return;
    }
    setShown({ kind: 'checking' });
    const result = await confirmCardSession(id);
    // Settled either way: a stored card, or an attempt that has ended.
    if (result.ok && (result.status === 'STORED' || result.reason !== 'no_new_card_yet')) {
      try {
        sessionStorage.removeItem(CARD_SESSION_KEY);
      } catch {
        /* nothing to keep */
      }
    }
    setShown({ kind: 'answer', result });
  };

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    if (cancelled) {
      try {
        sessionStorage.removeItem(CARD_SESSION_KEY);
      } catch {
        /* nothing to keep */
      }
      queueMicrotask(() => setShown({ kind: 'cancelled' }));
      return;
    }
    queueMicrotask(() => void check());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  const result = shown.kind === 'answer' ? shown.result : null;
  return (
    <section className={styles.cardReturn} data-testid="card-return" aria-live="polite">
      <p className={styles.heldSentence} data-testid="card-return-said">
        {shown.kind === 'checking'
          ? t('checking')
          : shown.kind === 'cancelled'
            ? t('cancelled')
            : shown.kind === 'none'
              ? t('nothingToCheck')
              : result!.ok
                ? result!.status === 'STORED'
                  ? t('stored', {
                      brand: result!.card.brand ?? t('aCard'),
                      last4: result!.card.last4 ?? '????',
                    })
                  : t(`pending.${result!.reason}`)
                : t(`refused.${result!.reason}`)}
      </p>
      <p className={styles.heldActions}>
        {result?.ok && result.status === 'PENDING' && result.reason === 'no_new_card_yet' ? (
          <button
            type="button"
            className={styles.cardGo}
            data-testid="card-check-again"
            onClick={() => void check()}
          >
            {t('checkAgain')}
          </button>
        ) : null}
        <Link
          href={{ pathname: '/settings/billing', query: { panel: 'details' } }}
          className={styles.heldCancel}
          data-testid="card-back"
        >
          {t('back')}
        </Link>
      </p>
    </section>
  );
}
