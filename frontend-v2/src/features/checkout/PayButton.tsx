'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';

import { startCheckoutPayment } from './actions';
import styles from './Checkout.module.css';

/**
 * Off to the provider's hosted card page, in this tab: a card form in a popup
 * or a frame teaches people to type card details where they cannot see the
 * address bar. Where it goes is billing's answer, never ours.
 *
 * `live` is BILLING_WRITES for this deployment, decided on the server: off,
 * the control is the uniform unavailable status with its reason, and the
 * action refuses on its own as well.
 */
export function PayButton({
  reference,
  label,
  live,
}: {
  readonly reference: string;
  readonly label: string;
  readonly live: boolean;
}) {
  const t = useTranslations('checkout.paymentRequired');
  const [pending, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState<'failed' | 'held' | null>(null);

  if (!live) {
    return (
      <UnavailableAction
        label={label}
        tag={t('held.tag')}
        why={t('held.why')}
        testid="checkout-pay"
      />
    );
  }

  const pay = () =>
    start(async () => {
      setRefused(null);
      const started = await startCheckoutPayment(reference);
      if (started.ok) {
        // Stays disabled while the browser leaves: a second press would open a second session.
        setLeaving(true);
        window.location.assign(started.url);
        return;
      }
      setRefused(started.kind);
    });

  const busy = pending || leaving;
  return (
    <>
      <p className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={pay}
          disabled={busy}
          aria-busy={busy}
          data-testid="checkout-pay"
        >
          {busy ? t('starting') : label}
        </button>
      </p>
      {refused ? (
        <p className={styles.error} role="alert" data-testid="checkout-pay-refused">
          {refused === 'held' ? t('held.why') : t('startFailed')}
        </p>
      ) : null}
    </>
  );
}
