import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';
import heNavigation from '@/i18n/messages/he/navigation.json';
import { PermissionsProvider, type PermissionsStatus } from '@/permissions/permissions-context';
import { ConsoleNavigation } from './PrimaryNavigation';

const at = vi.hoisted(() => ({ path: '/home' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => at.path,
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const rail = (
  roleKey: string | undefined,
  status: PermissionsStatus = 'loaded',
  locale: 'en' | 'he' = 'en',
) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ navigation: locale === 'he' ? heNavigation : navigation }}
    >
      <PermissionsProvider permissions={[]} roleKey={roleKey} status={status} tenantId="t-1">
        <ConsoleNavigation />
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );

describe('★★ the rail’s console entry - SYSTEM_ADMIN and nobody else', () => {
  it('★ a system admin sees it, linking to /system', () => {
    rail('system_admin');
    const link = screen.getByTestId('console-navigation');
    expect(link).toHaveAttribute('href', '/system');
    expect(link).toHaveTextContent('Console');
  });

  it('★★ an owner, an admin, an agent: no entry at all', () => {
    for (const role of ['owner', 'admin', 'agent']) {
      const { unmount } = rail(role);
      expect(screen.queryByTestId('console-navigation')).toBeNull();
      unmount();
    }
  });

  it('★★ permissions that could not be read open every other door - never this one', () => {
    rail(undefined, 'unavailable');
    expect(screen.queryByTestId('console-navigation')).toBeNull();
  });

  it('current on the console’s own pages, and in Hebrew', () => {
    at.path = '/system/tenants';
    rail('system_admin', 'loaded', 'he');
    const link = screen.getByTestId('console-navigation');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveTextContent('ניהול מערכת');
    at.path = '/home';
  });
});
