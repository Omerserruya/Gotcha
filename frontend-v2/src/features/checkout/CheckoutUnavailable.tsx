import { useTranslations } from 'next-intl';

import { CheckoutFrame, SUPPORT_MAILTO } from './CheckoutFrame';
import styles from './Checkout.module.css';

/**
 * A link that is wrong, spent, or not this visitor's - one state whatever the
 * cause, because billing answers all three with the same 404 so that nobody
 * learns whether a reference exists.
 */
export function CheckoutUnavailable() {
  const t = useTranslations('checkout');
  return (
    <CheckoutFrame
      title={t('unavailable.title')}
      lead={t('unavailable.lead')}
      testid="checkout-unavailable"
    >
      <p className={styles.actions}>
        <a className={styles.secondary} href={SUPPORT_MAILTO}>
          {t('support')}
        </a>
      </p>
    </CheckoutFrame>
  );
}
