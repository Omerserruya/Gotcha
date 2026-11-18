'use client';

import { BadgeCheck, House, MessageCircle, Send, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import { PERMISSIONS } from '@/permissions/catalogue';
import type { PermissionString } from '@/permissions/permission-set';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './MobileShell.module.css';
import { inMobileOverlay } from './mobile-paths';

export type MobileTabHref =
  '/m/home' | '/m/inbox' | '/m/approvals' | '/m/outreach' | '/m/customers';

interface MobileTab {
  readonly id: 'home' | 'inbox' | 'approvals' | 'outreach' | 'customers';
  readonly href: MobileTabHref;
  readonly icon: typeof MessageCircle;
  /** `null`: every signed-in member has it, as the desktop rail's Home. */
  readonly permission: PermissionString | null;
}

/*
 * The design's five tabs, in its order and with its icons (`GOTCHA Mobile
 * App.dc.html`: house, message-circle, badge-check, send, users). The
 * permissions are the desktop rail's, entry for entry (`shell/navigation.ts`),
 * so the phone never offers a tab the website would hide.
 */
export const MOBILE_TABS: readonly MobileTab[] = [
  { id: 'home', href: '/m/home', icon: House, permission: null },
  {
    id: 'inbox',
    href: '/m/inbox',
    icon: MessageCircle,
    permission: PERMISSIONS.conversation.messages.read,
  },
  {
    id: 'approvals',
    href: '/m/approvals',
    icon: BadgeCheck,
    permission: PERMISSIONS.approvals.requests.view,
  },
  {
    id: 'outreach',
    href: '/m/outreach',
    icon: Send,
    permission: PERMISSIONS.outbound.calls.view,
  },
  {
    id: 'customers',
    href: '/m/customers',
    icon: Users,
    permission: PERMISSIONS.customer.profile.read,
  },
];

/**
 * The tabs at the bottom of the phone.
 *
 * ★ HIDDEN ON A SCREEN THAT COVERS THE LIST (a conversation, an approval, a
 *   customer), as the design draws them: those are full screens with a way
 *   back, and in a conversation the composer owns the bottom edge.
 */
export function MobileTabs() {
  const t = useTranslations('mobile');
  const nav = useTranslations('navigation');
  const pathname = usePathname();
  const { canSee } = usePermissions();

  if (inMobileOverlay(pathname)) return null;
  const tabs = MOBILE_TABS.filter((tab) => tab.permission === null || canSee(tab.permission));
  if (tabs.length === 0) return null;

  return (
    <nav className={styles.tabs} aria-label={nav('mainNavigation')}>
      {tabs.map((tab) => {
        const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const Icon = tab.icon;
        return (
          <Link
            prefetch={false}
            key={tab.id}
            href={tab.href}
            className={styles.tab}
            aria-current={current ? 'page' : undefined}
            data-testid={`mobile-tab-${tab.id}`}
          >
            <span className={styles.tabPill}>
              <Icon aria-hidden size={22} strokeWidth={2} />
            </span>
            <span className={styles.tabLabel}>{t(`tabs.${tab.id}`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
