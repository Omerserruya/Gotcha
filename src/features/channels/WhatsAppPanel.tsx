import { List, MessageCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { Link } from '@/i18n/navigation';

import { PanelTabs } from './PanelTabs';
import { WHATSAPP_TABS, type WhatsAppTab } from './whatsapp-tabs';
import styles from './Channels.module.css';

/**
 * 13b - WhatsApp's settings as a PANEL over Channels, measured: a scrim over
 * the Settings frame, and a white drawer (640) at its end - the channel's
 * tile, "WhatsApp" (18/600), its line and a close; then its tabs.
 *
 * Its tabs are real (Omer, 2026-10-07): Numbers (its numbers, the history
 * import, the suggestions to review), Templates, Private contacts and
 * Activity - `?tab=`, each read only when it is open.
 */
export async function WhatsAppPanel({
  line,
  tab = 'numbers',
  children,
}: {
  /** The account in one line: how many numbers. */
  readonly line: string;
  /** The open tab (`?tab=`); its content is `children`. */
  readonly tab?: WhatsAppTab;
  readonly children: ReactNode;
}) {
  const t = await getTranslations('channels.whatsapp');
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
          <PanelTabs
            current={tab}
            label={t('title')}
            labels={
              Object.fromEntries(WHATSAPP_TABS.map((x) => [x, t(`tab.${x}`)])) as Record<
                WhatsAppTab,
                string
              >
            }
          />
        </header>
        <div
          className={styles.panelBody}
          role="tabpanel"
          id="whatsapp-tabpanel"
          aria-labelledby={`whatsapp-tab-${tab}`}
          data-testid={`whatsapp-tabpanel-${tab}`}
        >
          {children}
        </div>
        {/*
          02's foot: Refresh from Meta · Activity log, and Disconnect in red.
          The log is the Activity tab. Refresh and Disconnect are not wired
          from here: a status in the one look, never something to press.
        */}
        <footer className={styles.panelFoot}>
          <UnavailableAction
            label={t('foot.refresh')}
            tag={t('notYet')}
            why={t('footNotYet')}
            testid="whatsapp-foot-refresh"
          />
          <Link
            href={{ pathname: '/settings/channels', query: { panel: 'whatsapp', tab: 'activity' } }}
            replace
            scroll={false}
            className={styles.panelFootLink}
            data-testid="whatsapp-foot-activity"
          >
            <List size={13} aria-hidden="true" />
            {t('foot.activity')}
          </Link>
          <UnavailableAction
            label={t('foot.disconnect')}
            tag={t('notYet')}
            why={t('footNotYet')}
            testid="whatsapp-foot-disconnect"
          />
        </footer>
      </aside>
    </div>
  );
}
