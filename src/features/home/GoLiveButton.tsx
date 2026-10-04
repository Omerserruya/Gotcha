'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Link, useRouter } from '@/i18n/navigation';

import { goLive, type GoLiveResult } from './go-live-action';
import styles from './FirstSteps.module.css';

/**
 * 01c's Go live, live (Omer, decision 01). One press asks; the second goes
 * live. A refusal is said in words, with the way to clear it.
 */
export function GoLiveButton() {
  const t = useTranslations('home.firstSteps.goLive');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<Exclude<GoLiveResult, { ok: true }>['reason'] | null>(null);
  const [isPending, startTransition] = useTransition();

  if (asking) {
    return (
      <span className={styles.goLiveConfirm} data-testid="go-live-confirm">
        <span className={styles.goLiveAsk}>{t('confirm')}</span>
        <button
          type="button"
          className={styles.goLiveButton}
          disabled={isPending}
          data-testid="go-live-yes"
          onClick={() =>
            startTransition(async () => {
              const result = await goLive();
              if (result.ok) {
                router.refresh();
                return;
              }
              setFailed(result.reason);
              setAsking(false);
            })
          }
        >
          {isPending ? t('going') : t('yes')}
        </button>
        <button
          type="button"
          className={styles.goLiveCancel}
          disabled={isPending}
          data-testid="go-live-cancel"
          onClick={() => setAsking(false)}
        >
          {t('cancel')}
        </button>
      </span>
    );
  }
  return (
    <span className={styles.goLiveConfirm}>
      <button
        type="button"
        className={styles.goLiveButton}
        data-testid="go-live-button"
        onClick={() => {
          setFailed(null);
          setAsking(true);
        }}
      >
        {t('go')}
      </button>
      {failed ? (
        <span className={styles.goLiveProblem} role="alert" data-testid="go-live-problem">
          {t(`failed.${failed}`)}
          {failed === 'store' ? (
            <>
              {' '}
              <Link href="/settings/systems">{t('connectStore')}</Link>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
