import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { Logo } from '@/design-system/brand/Logo';
import { Link } from '@/i18n/navigation';

import styles from './AppShell.module.css';
import { AccountControl } from './AccountControl';
import { CommandHint } from './CommandHint';
import { PrimaryNavigation, SettingsNavigation } from './PrimaryNavigation';

/**
 * The application frame.
 *
 * A dark shell holding the rail, with the work surface as a light panel
 * floating inside it. This is the design's central idea and the reason the
 * markup is shaped this way rather than as a conventional sidebar-plus-header.
 *
 * A Server Component: the frame itself has no interactive state, so shipping
 * it as client JavaScript would cost every user a download for nothing. Only
 * the two controls that genuinely need interactivity are client components.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('navigation');

  return (
    <div className={styles.frame}>
      {/*
        First focusable element on the page. Without it, a keyboard user
        re-traverses the whole rail on every single page load.
      */}
      <a href="#main-content" className={styles.skipLink}>
        {t('skipToContent')}
      </a>

      {/* `data-rail` is a stable hook for layout tests; CSS Module class
          names are hashed and cannot be selected on. */}
      <div className={styles.rail} data-rail>
        <div className={styles.railTop}>
          <Link href="/home" className={styles.brand}>
            {/* No title: the wordmark beside it already names the product, and
                announcing it twice is noise for a screen reader. */}
            <Logo variant="framed" size={26} />
            GOTCHA
          </Link>
          <PrimaryNavigation />
        </div>

        <div className={styles.railBottom}>
          <CommandHint />
          <SettingsNavigation />
          <AccountControl />
        </div>
      </div>

      <div className={styles.surface}>
        {/* `tabIndex={-1}` so the skip link can actually move focus here. */}
        <main id="main-content" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
