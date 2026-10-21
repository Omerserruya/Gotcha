'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { resendWelcome } from './actions';
import styles from './Checkout.module.css';

/**
 * The quiet repair path on the paid page: for the admin whose invoice someone
 * else paid, the welcome email is the one thing carrying a way to set a
 * password, so asking for it again needs no permission they cannot yet hold.
 */
export function ResendWelcome({ reference }: { readonly reference: string }) {
  const t = useTranslations('checkout.completed');
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<'resent' | 'resendFailed' | null>(null);

  const resend = () =>
    start(async () => {
      const { sent } = await resendWelcome(reference);
      setSaid(sent ? 'resent' : 'resendFailed');
    });

  return (
    <p className={styles.quiet} role="status" aria-live="polite" data-testid="checkout-resend">
      {said ? (
        t(said)
      ) : (
        <>
          {t('noEmail')}{' '}
          <button
            type="button"
            className={styles.link}
            onClick={resend}
            disabled={pending}
            data-testid="checkout-resend-button"
          >
            {pending ? t('resending') : t('resend')}
          </button>
        </>
      )}
    </p>
  );
}
