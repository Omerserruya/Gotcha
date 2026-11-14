import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The rail's parts, as markers: which ones the shell draws is the subject.
 * ★ A system admin of a tenant not live (prod's "System", 2026-10-23) gets
 *   the console and the account only - every product part reads or links
 *   pages that answer 402 for that tenant.
 */
const marker = (id: string) =>
  function Marker() {
    return <i data-testid={id} />;
  };
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/api/client/server-api', () => ({
  serverApi: () => ({
    get: async () => ({
      user: { name: 'Platform Admin', email: 'a@x.test' },
      tenantName: 'System',
    }),
  }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className} data-testid="brand">
      {children}
    </a>
  ),
}));
vi.mock('@/design-system/brand/Logo', () => ({ Logo: () => null }));
vi.mock('./AccountControl', () => ({ AccountControl: marker('account') }));
vi.mock('./CommandHint', () => ({ CommandHint: marker('command-hint') }));
vi.mock('./CommandPalette', () => ({ CommandPalette: marker('command-palette') }));
vi.mock('./RecentThreads', () => ({ RecentThreads: marker('recent-threads') }));
vi.mock('./PrimaryNavigation', () => ({
  PrimaryNavigation: marker('primary-nav'),
  SettingsNavigation: marker('settings-nav'),
  ConsoleNavigation: marker('console-nav'),
}));

const { AppShell } = await import('./AppShell');

const PRODUCT = [
  'primary-nav',
  'recent-threads',
  'command-hint',
  'command-palette',
  'settings-nav',
];

describe('the rail', () => {
  it('as everyone has it: the product, settings, the console entry where the role has one, the account', async () => {
    render(await AppShell({ children: <p>page</p> }));
    for (const id of [...PRODUCT, 'console-nav', 'account']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId('brand')).toHaveAttribute('href', '/home');
  });

  it('★★ console only: the console and the account, nothing of the product, and the brand goes to /system', async () => {
    render(await AppShell({ children: <p>page</p>, consoleOnly: true }));
    for (const id of PRODUCT) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId('console-nav')).toBeInTheDocument();
    expect(screen.getByTestId('account')).toBeInTheDocument();
    expect(screen.getByTestId('brand')).toHaveAttribute('href', '/system');
    expect(screen.getByText('page')).toBeInTheDocument();
  });
});
