'use client';

import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import { CONSOLE_NAVIGATION, CONSOLE_SECTIONS } from './navigation';
import styles from './SettingsSections.module.css';

/**
 * The console's sections, as a sidebar inside the panel - Settings' shape
 * (`SettingsSections`), so the operator's console reads as part of the same
 * product rather than legacy's second app. No permission filter: the whole
 * console is behind one door (`require-console.ts`).
 */
export function ConsoleSections() {
  const t = useTranslations('console');
  const tNav = useTranslations('navigation');
  const pathname = usePathname();

  return (
    <nav className={styles.sidebar} aria-label={tNav(CONSOLE_NAVIGATION.labelKey)}>
      <p className={styles.heading}>{tNav(CONSOLE_NAVIGATION.labelKey)}</p>
      {CONSOLE_SECTIONS.map((section) => {
        const href = section.href ?? CONSOLE_NAVIGATION.href;
        return (
          <Link
            key={section.id}
            href={href}
            className={styles.link}
            aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
          >
            {t(section.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
