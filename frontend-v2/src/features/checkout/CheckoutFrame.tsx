import type { ReactNode } from 'react';

import { Logo } from '@/design-system/brand/Logo';

import styles from './Checkout.module.css';

/**
 * One checkout page: the mark, a card, its title and sentence, and whatever
 * the page has to show or offer. No rail, no account: whoever is here may not
 * be signed in, and is deciding whether to trust us with a card.
 */
export function CheckoutFrame({
  title,
  lead,
  children,
  testid,
}: {
  readonly title: string;
  readonly lead?: string;
  readonly children?: ReactNode;
  readonly testid: string;
}) {
  return (
    <main className={styles.frame} data-testid={testid}>
      <span className={styles.brand}>
        <Logo variant="framed" size={26} />
        GOTCHA
      </span>
      <div className={styles.card}>
        <h1 className={styles.title}>{title}</h1>
        {lead ? (
          <p className={styles.lead} data-testid="checkout-lead">
            {lead}
          </p>
        ) : null}
        {children ? <div className={styles.body}>{children}</div> : null}
      </div>
    </main>
  );
}

/** The support address billing's own emails give (`support@gotcha.co.il`). */
export const SUPPORT_MAILTO = 'mailto:support@gotcha.co.il';
