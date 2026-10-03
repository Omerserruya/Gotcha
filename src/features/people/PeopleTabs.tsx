import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './People.module.css';

export type PeopleTab = 'people' | 'roles' | 'teams';

/**
 * 12 / 12b's tabs under the shared header: People · Roles · Teams, each with
 * its count. Roles is its own page (12b) under the same header; Teams is a
 * view of 12 (`?tab=teams`).
 */
export async function PeopleTabs({
  current,
  counts,
}: {
  readonly current: PeopleTab;
  /** `null` where the read failed: no count, never a zero. */
  readonly counts: { readonly [K in PeopleTab]: number | null };
}) {
  const t = await getTranslations('people');
  const href = {
    people: { pathname: '/settings/people' },
    roles: { pathname: '/settings/people/roles' },
    teams: { pathname: '/settings/people', query: { tab: 'teams' } },
  } as const;
  return (
    <nav className={styles.tabs} aria-label={t('tabs.label')}>
      {(['people', 'roles', 'teams'] as const).map((tab) => (
        <Link
          key={tab}
          href={href[tab]}
          className={styles.tab}
          aria-current={tab === current ? 'page' : undefined}
          data-testid={`people-tab-${tab}`}
        >
          {t(`tabs.${tab}`)}
          {counts[tab] !== null ? <span className={styles.tabCount}>{counts[tab]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
