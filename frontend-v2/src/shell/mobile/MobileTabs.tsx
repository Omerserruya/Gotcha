'use client';

import { ListChecks, Megaphone, MessageCircle, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import { PERMISSIONS } from '@/permissions/catalogue';
import type { PermissionString } from '@/permissions/permission-set';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './MobileShell.module.css';
import { inMobileThread } from './mobile-paths';

interface MobileTab {
  readonly id: 'inbox' | 'approvals' | 'outreach' | 'customers';
  readonly href: '/m/inbox' | '/m/approvals' | '/m/outreach' | '/m/customers';
  readonly icon: typeof MessageCircle;
  readonly permission: PermissionString;
}

/*
 * The desktop rail's permissions, entry for entry (`shell/navigation.ts`), so
 * the phone never offers a tab the website would hide.
 */
export const MOBILE_TABS: readonly MobileTab[] = [
  {
    id: 'inbox',
    href: '/m/inbox',
    icon: MessageCircle,
    permission: PERMISSIONS.conversation.messages.read,
  },
  {
    id: 'approvals',
    href: '/m/approvals',
    icon: ListChecks,
    permission: PERMISSIONS.approvals.requests.view,
  },
  {
    id: 'outreach',
    href: '/m/outreach',
    icon: Megaphone,
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
 * The four tabs at the bottom of the phone.
 *
 * ★ HIDDEN INSIDE A CONVERSATION, as WhatsApp does: the composer owns the
 *   bottom edge there, and a tab bar under it would push the field the
 *   keyboard has to sit on halfway up the screen.
 */
export function MobileTabs() {
  const t = useTranslations('navigation');
  const pathname = usePathname();
  const { canSee } = usePermissions();

  if (inMobileThread(pathname)) return null;
  const tabs = MOBILE_TABS.filter((tab) => canSee(tab.permission));
  if (tabs.length === 0) return null;

  return (
    <nav className={styles.tabs} aria-label={t('mainNavigation')}>
      {tabs.map((tab) => {
        const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={styles.tab}
            aria-current={current ? 'page' : undefined}
            data-testid={`mobile-tab-${tab.id}`}
          >
            <Icon aria-hidden size={22} strokeWidth={current ? 2.2 : 1.8} />
            <span className={styles.tabLabel}>{t(`primary.${tab.id}`)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
