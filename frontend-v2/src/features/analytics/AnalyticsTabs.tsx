import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './Analytics.module.css';

/**
 * 02's tabs: Overview · GOTCHA · Team · Sales · Topics.
 *
 * Drawn now that each leads somewhere - the only reason they were not.
 * `?tab=`, so a tab is a URL; Overview is the bare route.
 */
export const ANALYTICS_TABS = ['overview', 'gotcha', 'team', 'sales', 'topics'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export function parseAnalyticsTab(raw: string | undefined): AnalyticsTab {
  return (ANALYTICS_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as AnalyticsTab)
    : 'overview';
}

export async function AnalyticsTabs({ current }: { readonly current: AnalyticsTab }) {
  const t = await getTranslations('analytics');
  return (
    <nav className={styles.tabs} aria-label={t('tabs.label')} data-testid="analytics-tabs">
      {ANALYTICS_TABS.map((tab) => (
        <Link
          key={tab}
          href={{ pathname: '/analytics', query: tab === 'overview' ? {} : { tab } }}
          className={styles.tab}
          aria-current={current === tab ? 'page' : undefined}
          data-testid={`analytics-tab-${tab}`}
        >
          {t(`tabs.${tab}`)}
        </Link>
      ))}
    </nav>
  );
}
