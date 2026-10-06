import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

import styles from './Outreach.module.css';

export type OutreachTab = 'inFlight' | 'templates' | 'calls' | 'finished';

const HREF: Record<Exclude<OutreachTab, 'finished'>, string> = {
  inFlight: '/outreach',
  templates: '/outreach/templates',
  calls: '/outreach/calls',
};

/**
 * 05b-05d's header pills: In flight · Templates · Calls · Finished, the open
 * one dark, then the screen's own button. "Finished" has no list of its own -
 * 05's list ends on what already went - so it is the open pill on a
 * campaign's results (05b) and, elsewhere, leads to that list.
 */
export async function OutreachTabs({
  current,
  children,
}: {
  readonly current: OutreachTab;
  /** The screen's own action, right of the pills ("Start a call", "New template"). */
  readonly children?: ReactNode;
}) {
  const t = await getTranslations('outreach.tabs');
  const tabs: OutreachTab[] = ['inFlight', 'templates', 'calls', 'finished'];
  return (
    <div className={styles.tabsRow}>
      <nav className={styles.tabs} aria-label={t('label')} data-testid="outreach-tabs">
        {tabs.map((tab) => (
          <Link
            key={tab}
            href={tab === 'finished' ? '/outreach' : HREF[tab]}
            className={styles.tab}
            aria-current={tab === current ? 'page' : undefined}
            title={tab === 'finished' && current !== 'finished' ? t('finishedWhere') : undefined}
            data-testid={`outreach-tab-${tab}`}
          >
            {t(tab)}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
