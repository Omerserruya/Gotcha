import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './Billing.module.css';

/**
 * 17c, 17d and 17e open over 17 — a drawer from the end (When credits run
 * low, Billing details) or a dialog in the middle (Buy credits), on 02's
 * scrim. The URL holds the state (`?panel=`), so the scrim and the X are both
 * the way back to 17.
 */
export async function BillingOverlay({
  kind,
  title,
  line,
  children,
}: {
  readonly kind: 'drawer' | 'dialog';
  readonly title: string;
  /** 02's muted line under the title. */
  readonly line?: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('billing.overview.overlay');
  return (
    <div className={styles.overlayLayer} data-testid="billing-overlay" data-kind={kind}>
      <Link
        href="/settings/billing"
        className={styles.overlayScrim}
        aria-label={t('close')}
        tabIndex={-1}
      />
      <aside
        className={kind === 'drawer' ? styles.overlayDrawer : styles.overlayDialog}
        aria-label={title}
      >
        <header className={styles.overlayHead}>
          <div className={styles.overlayTitles}>
            <h2 className={styles.overlayTitle}>{title}</h2>
            {line ? <p className={styles.overlayLine}>{line}</p> : null}
          </div>
          <Link
            href="/settings/billing"
            className={styles.overlayClose}
            aria-label={t('close')}
            data-testid="billing-overlay-close"
          >
            <X size={16} aria-hidden="true" />
          </Link>
        </header>
        <div className={styles.overlayBody}>{children}</div>
      </aside>
    </div>
  );
}
