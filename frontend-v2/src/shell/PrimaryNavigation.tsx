'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

import { Link, usePathname } from '@/i18n/navigation';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './AppShell.module.css';
import {
  isCurrentHrefChild,
  PRIMARY_NAVIGATION,
  SETTINGS_NAVIGATION,
  type NavigationChild,
  type NavigationItem,
} from './navigation';

/**
 * The rail: seven destinations, then the current one's sub-navigation.
 *
 * The destination list is never modified - not re-ordered, not indented, not
 * interrupted by a child group. Sub-navigation is appended *after* it as its
 * own block, under a rule and a mono label, exactly as the design draws the
 * Inbox rail. Keeping the first block identical on every screen is what lets
 * the eye go straight to a remembered position instead of re-reading the rail
 * each time a destination changes shape.
 *
 * Sections the user has no permission for are hidden rather than disabled.
 * That is right *here* specifically - a product area someone will never open is
 * noise in a list they read all day. Actions inside a page follow the opposite
 * default and stay visible with an explanation; see `useCapability`.
 */
export function PrimaryNavigation() {
  const t = useTranslations('navigation');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { canSee } = usePermissions();

  const isPermitted = (entry: { permission?: string }) => canSee(entry.permission);

  // Prefix match, so `/inbox/123` still marks Inbox as the current destination.
  const isCurrentDestination = (item: NavigationItem) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`);

  const destinations = PRIMARY_NAVIGATION.filter(isPermitted);
  const settings = isPermitted(SETTINGS_NAVIGATION) ? SETTINGS_NAVIGATION : null;

  /** At most one destination is current, so at most one child group shows. */
  const active =
    destinations.find(isCurrentDestination) ??
    (settings && isCurrentDestination(settings) ? settings : undefined);

  function isCurrentChild(parent: NavigationItem, child: NavigationChild): boolean {
    if (child.href) return isCurrentHrefChild(pathname, child, parent.children ?? []);
    if (!parent.viewParam) return false;
    const current = searchParams.get(parent.viewParam) ?? parent.defaultView;
    return current === child.view;
  }

  function childHref(parent: NavigationItem, child: NavigationChild): string {
    if (child.href) return child.href;
    // A view is a filter over the parent page, so it lives in the query string
    // where it stays deep-linkable and composes with the page's own filters.
    return `${parent.href}?${parent.viewParam}=${child.view}`;
  }

  const renderDestination = (item: NavigationItem) => (
    <li key={item.id}>
      <Link
        href={item.href}
        className={styles.navLink}
        // `aria-current` rather than a class alone: it is how a screen reader
        // announces where the user is.
        aria-current={isCurrentDestination(item) ? 'page' : undefined}
      >
        <span className={styles.navDot} aria-hidden="true" />
        <span>{t(item.labelKey)}</span>
      </Link>
    </li>
  );

  const children = (active?.children ?? []).filter(isPermitted);
  const groupLabel = active?.childrenLabelKey ? t(active.childrenLabelKey) : '';

  return (
    <>
      <nav aria-label={t('mainNavigation')}>
        <ul className={styles.navList} role="list">
          {destinations.map(renderDestination)}
        </ul>
      </nav>

      {active && children.length > 0 ? (
        <nav className={styles.subNavGroup} aria-label={groupLabel}>
          {/* `aria-hidden`: the label already names the nav landmark above, and
              announcing it twice is noise for a screen-reader user. */}
          <span className={styles.subNavLabel} aria-hidden="true">
            {groupLabel}
          </span>
          <ul className={styles.subNavList} role="list">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  href={childHref(active, child)}
                  className={styles.subNavLink}
                  aria-current={isCurrentChild(active, child) ? 'page' : undefined}
                >
                  {t(child.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </>
  );
}

/**
 * Settings, pinned to the rail's foot.
 *
 * Separate from the seven because it is not a place you work; it is where you
 * change how the others behave, and the design keeps that distinction spatial.
 */
export function SettingsNavigation() {
  const t = useTranslations('navigation');
  const pathname = usePathname();
  const { canSee } = usePermissions();

  if (!canSee(SETTINGS_NAVIGATION.permission)) return null;

  const isCurrent =
    pathname === SETTINGS_NAVIGATION.href || pathname.startsWith(`${SETTINGS_NAVIGATION.href}/`);

  return (
    <Link
      href={SETTINGS_NAVIGATION.href}
      className={styles.navLink}
      aria-current={isCurrent ? 'page' : undefined}
    >
      <span className={styles.navDot} aria-hidden="true" />
      <span>{t(SETTINGS_NAVIGATION.labelKey)}</span>
    </Link>
  );
}
