import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import styles from './ConsoleHome.module.css';
import { CONSOLE_SECTIONS } from './navigation';

/**
 * The sections, built from the same list as the sidebar - a section added
 * there appears here without anyone remembering to (STUDIO_SECTIONS' rule).
 */
export function ConsoleHome() {
  const t = useTranslations('console');
  if (CONSOLE_SECTIONS.length === 0) return null;
  return (
    <ul className={styles.sections} role="list" data-testid="console-sections">
      {CONSOLE_SECTIONS.map((section) => (
        <li key={section.id}>
          <Link href={section.href ?? '/system'} className={styles.sectionLink}>
            <span className={styles.sectionName}>{t(section.labelKey)}</span>
            <span className={styles.sectionLine}>{t(`${section.labelKey}Line`)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
