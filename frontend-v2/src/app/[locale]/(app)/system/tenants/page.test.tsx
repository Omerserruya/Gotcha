import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** /system/tenants: behind the door, the search from the address, a failed read said. */
const door = vi.hoisted(() => ({ open: true }));
const loadTenants = vi.hoisted(() => vi.fn());
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/features/console/load-tenants', () => ({ loadTenants }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.tenants') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

const { default: Page } = await import('./page');

const open = async (q?: string | string[]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page({ searchParams: Promise.resolve(q === undefined ? {} : { q }) })}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  door.open = true;
  loadTenants.mockReset();
  loadTenants.mockResolvedValue({ ok: true, tenants: [], total: 0, provisioning: {} });
});

describe('★★ /system/tenants', () => {
  it('★★ not a system admin: not found, and nothing is read', async () => {
    door.open = false;
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadTenants).not.toHaveBeenCalled();
  });

  it('★ the search is the address’s ?q=, trimmed', async () => {
    await open('  acme ');
    expect(loadTenants).toHaveBeenCalledWith('acme');
    expect(screen.getByRole('searchbox', { name: 'Search tenants' })).toHaveValue('acme');
  });

  it('no search: all of them', async () => {
    await open();
    expect(loadTenants).toHaveBeenCalledWith('');
  });

  it('★ the list unread says so - it is not "no tenants"', async () => {
    loadTenants.mockResolvedValue({ ok: false });
    await open();
    expect(screen.getByTestId('tenants-unread')).toHaveTextContent(
      "The tenants couldn't be read. Reload the page to try again.",
    );
    expect(screen.queryByTestId('tenants-empty')).toBeNull();
  });
});
