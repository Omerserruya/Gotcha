'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { Logo } from '@/design-system/brand/Logo';

import styles from './WorkspaceGate.module.css';

/**
 * The product's closed door (onboarding is a gate - Omer, 2026-10-07): no
 * rail, no ⌘K, one sentence and, where there is one, the way on.
 *
 *   waiting      a member of a workspace an admin is still setting up
 *   unavailable  the workspace's status could not be read: Retry - never
 *                the product, and never a lock-out that outlives a reload
 *   payment      the checkout's payment page (`paymentPath`), in this
 *                language: the open checkout's, else the entry page
 */
export function WorkspaceGate({
  route,
  paymentPath = null,
  setupAdmin = null,
}: {
  readonly route: 'waiting' | 'unavailable' | 'payment';
  readonly paymentPath?: string | null;
  /** Who is setting it up, when the server names them (only while it is). */
  readonly setupAdmin?: string | null;
}) {
  const t = useTranslations('onboarding.gate');

  useEffect(() => {
    // The server already decided this workspace pays first; the browser obeys.
    if (route === 'payment' && paymentPath) window.location.replace(paymentPath);
  }, [route, paymentPath]);

  return (
    <main className={styles.gate} data-testid={`gate-${route}`}>
      <span className={styles.brand}>
        <Logo variant="framed" size={26} />
        GOTCHA
      </span>
      <div className={styles.card}>
        <h1 className={styles.title}>{t(`${route}.title`)}</h1>
        <p className={styles.lead} data-testid="gate-lead">
          {route === 'waiting' && setupAdmin
            ? t.rich('waiting.leadBy', { name: () => <bdi dir="auto">{setupAdmin}</bdi> })
            : t(`${route}.lead`)}
        </p>
        {route === 'unavailable' ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => window.location.reload()}
            data-testid="gate-retry"
          >
            {t('unavailable.retry')}
          </button>
        ) : route === 'payment' && paymentPath ? (
          <a href={paymentPath} className={styles.primary} data-testid="gate-pay">
            {t('payment.go')}
          </a>
        ) : null}
      </div>
    </main>
  );
}
