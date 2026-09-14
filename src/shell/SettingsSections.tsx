'use client';

import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import { usePermissions } from '@/permissions/permissions-context';

import { SETTINGS_SECTIONS } from './navigation';
import styles from './SettingsSections.module.css';

/**
 * The eight Settings sections, as a sidebar inside the work surface.
 *
 * Named for the sections rather than "navigation" because the rail already
 * exports a `SettingsNavigation` - the single link that reaches this page.
 *
 * Deliberately not the rail. Inbox and Studio reveal their sections there
 * because those are filters over one page; a Settings section is a page of its
 * own, and eight more entries under the seven destinations would read as
 * fifteen destinations. Screens 11-18 draw it exactly this way.
 *
 * A section the viewer cannot reach is absent rather than disabled - a
 * disabled row is an invitation to ask for something they may not be meant to
 * know exists.
 */
export function SettingsSections({
  /** Section ids with something needing attention, e.g. a dead integration. */
  alerts = [],
}: {
  alerts?: readonly string[];
}) {
  const t = useTranslations('navigation');
  const pathname = usePathname();
  const { canSee } = usePermissions();

  const sections = SETTINGS_SECTIONS.filter((section) => canSee(section.permission));

  return (
    <nav className={styles.sidebar} aria-label={t('primary.settings')}>
      <p className={styles.heading}>{t('primary.settings')}</p>

      {sections.map((section) => {
        const href = section.href ?? '/settings';
        return (
          <Link
            key={section.id}
            href={href}
            className={styles.link}
            aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
          >
            {t(section.labelKey)}
            {alerts.includes(section.id) ? (
              <span className={styles.alert} aria-hidden="true" />
            ) : null}
          </Link>
        );
      })}

      {/*
        What this page is not. The design pins it to the foot because the
        question it answers - "why can't I change how GOTCHA replies here?" -
        is the one someone asks after reading the whole page.
      */}
      <p className={styles.footnote}>
        {t.rich('settingsFootnote', {
          studio: (chunks) => (
            <Link href="/studio" className={styles.footnoteLink}>
              {chunks}
            </Link>
          ),
        })}
      </p>
    </nav>
  );
}
