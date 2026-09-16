'use client';

import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';

import styles from './SettingsFootnote.module.css';

/**
 * What Settings is NOT: AI behaviour lives in Studio.
 *
 * A sibling of the section list rather than a child of it, because the two
 * want different places at different widths. On a wide screen the design pins
 * this to the foot of the sidebar — the question it answers, *"why can't I
 * change how GOTCHA replies here?"*, is the one someone asks after reading the
 * whole page. On a phone the sidebar is a strip along the top with no foot to
 * pin anything to, and "after reading the page" means below the page.
 *
 * So the layout places it, and it is rendered once either way: a second copy
 * would put a duplicate link to Studio in the accessibility tree.
 */
export function SettingsFootnote() {
  const t = useTranslations('navigation');

  return (
    <p className={styles.footnote}>
      {t.rich('settingsFootnote', {
        studio: (chunks) => (
          <Link href="/studio" className={styles.footnoteLink}>
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
