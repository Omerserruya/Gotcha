import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import consoleEn from '@/i18n/messages/en/console.json';

/** /system/coupons: behind the door, billing held said up front. */
const { door, writes, loadCoupons } = vi.hoisted(() => ({
  door: { open: true },
  writes: { on: false },
  loadCoupons: vi.fn(),
}));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/features/console/load-coupons', () => ({ loadCoupons }));
vi.mock('@/features/console/CouponsScreen', () => ({
  CouponsScreen: ({ coupons }: { coupons?: unknown[] }) => (
    <div data-testid="coupons-screen" data-count={coupons?.length ?? 'unread'} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.coupons') =>
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

const open = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page()}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  door.open = true;
  writes.on = false;
  loadCoupons.mockReset();
  loadCoupons.mockResolvedValue([]);
});

describe('★★ /system/coupons', () => {
  it('★★ not a system admin: not found, and nothing is read', async () => {
    door.open = false;
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadCoupons).not.toHaveBeenCalled();
  });

  it('★ the coupons, under their title', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Coupons');
    expect(screen.getByTestId('coupons-screen')).toHaveAttribute('data-count', '0');
  });

  it('★★ billing writes off here: said up front; on: not', async () => {
    const { unmount } = await open();
    expect(screen.getByTestId('billing-held')).toBeInTheDocument();
    unmount();
    writes.on = true;
    await open();
    expect(screen.queryByTestId('billing-held')).toBeNull();
  });
});
