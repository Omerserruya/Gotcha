import { List, MessageCircle, RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './Channels.module.css';

/**
 * 13b - WhatsApp's settings as a PANEL over Channels, measured: a scrim over
 * the Settings frame, and a white drawer (640) at its end - the channel's
 * tile, "WhatsApp" (18/600), its line and a close; then its tabs.
 *
 * Numbers is the panel's live tab (its numbers, the history import, the
 * suggestions to review). Templates, Private contacts and Activity are drawn
 * and not live yet - said on each.
 */
export async function WhatsAppPanel({
  line,
  children,
}: {
  /** The account in one line: how many numbers. */
  readonly line: string;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('channels.whatsapp');
  const tabs = ['numbers', 'templates', 'contacts', 'activity'] as const;
  return (
    <div className={styles.panelLayer} data-testid="whatsapp-panel">
      {/* The scrim closes it, as the X does: both are the way back to 13. */}
      <Link
        href="/settings/channels"
        className={styles.panelScrim}
        aria-label={t('close')}
        tabIndex={-1}
      />
      <aside className={styles.panel} aria-label={t('title')}>
        <header className={styles.panelHead}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelTile} aria-hidden="true">
              <MessageCircle size={20} strokeWidth={1.75} />
            </span>
            <span className={styles.panelTitles}>
              <h2 className={styles.panelTitle}>{t('panelTitle')}</h2>
              <span className={styles.panelLine}>{line}</span>
            </span>
            <Link
              href="/settings/channels"
              className={styles.panelClose}
              aria-label={t('close')}
              data-testid="whatsapp-close"
            >
              <X size={16} aria-hidden="true" />
            </Link>
          </div>
          <nav className={styles.panelTabs} aria-label={t('title')}>
            {tabs.map((tab) =>
              tab === 'numbers' ? (
                <span key={tab} className={styles.panelTab} aria-current="page">
                  {t(`tab.${tab}`)}
                </span>
              ) : (
                <span
                  key={tab}
                  className={styles.panelTab}
                  aria-disabled="true"
                  title={t('tabNotYet')}
                >
                  {t(`tab.${tab}`)}
                </span>
              ),
            )}
          </nav>
        </header>
        <div className={styles.panelBody}>{children}</div>
        {/*
          02's foot: Refresh from Meta · Activity log, and Disconnect in red.
          None is wired from here yet - drawn, each saying so.
        */}
        <footer className={styles.panelFoot}>
          <span className={styles.panelFootLink} aria-disabled="true" title={t('footNotYet')}>
            <RefreshCw size={13} aria-hidden="true" />
            {t('foot.refresh')}
          </span>
          <span className={styles.panelFootLink} aria-disabled="true" title={t('footNotYet')}>
            <List size={13} aria-hidden="true" />
            {t('foot.activity')}
          </span>
          <span className={styles.panelFootDanger} aria-disabled="true" title={t('footNotYet')}>
            {t('foot.disconnect')}
          </span>
        </footer>
      </aside>
    </div>
  );
}
