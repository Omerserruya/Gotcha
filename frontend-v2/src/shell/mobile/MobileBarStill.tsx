import { useLocale } from 'next-intl';
import type { ReactNode } from 'react';

import mirror from '@/design-system/patterns/directional-icon.module.css';
import { directionOf } from '@/i18n/locales';

import styles from './MobileBar.module.css';
import type { MobileTabHref } from './MobileTabs';

/**
 * `MobileBar` as a `loading.tsx` draws it: the same shapes and classes, with
 * NO client component anywhere in it.
 *
 * ⚠⚠ WHY A SECOND BAR. Next writes a loading segment's client chunks as
 *    `<script async>` without the CSP nonce, and `'strict-dynamic'` refuses
 *    them. Turbopack then waits on that refused tag for the page that needs
 *    the same chunk, and the page never shows: the customer screen sat on the
 *    thread's skeleton (dev, 2026-11-04). `MobileBar` brings next-intl's
 *    `Link`, `DirectionalIcon`, lucide's icons and `MobileAccountMenu`, all
 *    client. So here:
 *    - back is a plain `<a>` to the locale's path (a tap while loading is a
 *      full load);
 *    - the arrow is an inline SVG, mirrored for a right-to-left locale on the
 *      server;
 *    - the account menu is its button's shape, inert.
 *    `src/loading-no-client.test.ts` keeps every phone `loading.tsx` this way.
 */
export function MobileBarStill({
  title,
  brand = false,
  back,
  edge = false,
}: {
  readonly title?: ReactNode;
  readonly brand?: boolean;
  readonly back?: { readonly href: MobileTabHref; readonly label: string };
  readonly edge?: boolean;
}) {
  const locale = useLocale();
  return (
    <header
      className={styles.bar}
      data-back={back === undefined ? undefined : ''}
      data-edge={edge ? '' : undefined}
    >
      <div className={styles.row}>
        {back === undefined ? null : (
          <a
            href={`/${locale}${back.href}`}
            className={styles.iconButton}
            aria-label={back.label}
            data-testid="mobile-back"
          >
            <svg
              width={23}
              height={23}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={directionOf(locale) === 'rtl' ? mirror.mirrored : undefined}
            >
              <path d="m12 19-7-7 7-7" />
              <path d="M19 12H5" />
            </svg>
          </a>
        )}
        {brand ? (
          <span className={styles.brand}>GOTCHA</span>
        ) : (
          <div className={styles.title}>{title}</div>
        )}
        {brand ? <span className={styles.fill} /> : null}
        {back === undefined ? <MobileAccountStill /> : null}
      </div>
    </header>
  );
}

/** The account menu's button while the screen loads: its place and its dots, not yet a menu. */
export function MobileAccountStill() {
  return (
    <span className={styles.iconButton} aria-hidden="true" data-testid="mobile-account-still">
      <svg
        width={22}
        height={22}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="1" />
        <circle cx="12" cy="5" r="1" />
        <circle cx="12" cy="19" r="1" />
      </svg>
    </span>
  );
}
