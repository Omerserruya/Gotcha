import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tenantDetailSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** One tenant's page: behind the door, missing vs unread, and billing held said up front. */
const { door, writes, loadTenant } = vi.hoisted(() => ({
  door: { open: true },
  writes: { on: false },
  loadTenant: vi.fn(),
}));
vi.mock('@/shell/require-console', () => ({
  requireConsole: async () => {
    if (!door.open) throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
vi.mock('@/features/console/load-tenant', () => ({ loadTenant }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'console.detail') =>
    createTranslator({ locale: 'en', messages: { console: consoleEn }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({
    title,
    back,
    children,
  }: {
    title: ReactNode;
    back?: { href: string; label: string };
    children: ReactNode;
  }) => (
    <section>
      {back ? <a href={back.href}>{back.label}</a> : null}
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));
vi.mock('@/features/console/TenantFacts', () => ({
  TenantFacts: () => <div data-testid="facts" />,
}));
vi.mock('@/features/console/TenantBilling', () => ({
  TenantBilling: ({ tenantId }: { tenantId: string }) => (
    <div data-testid={`billing-${tenantId}`} />
  ),
}));
vi.mock('@/features/console/TenantCoupons', () => ({
  TenantCoupons: () => <div data-testid="coupons" />,
}));
vi.mock('@/features/console/TenantControls', () => ({
  TenantControls: () => <div data-testid="controls" />,
}));

const { default: Page } = await import('./page');

const tenant = tenantDetailSchema.parse({
  id: 't1',
  name: 'Acme',
  slug: 'acme',
  status: 'ACTIVE',
  isActive: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  planAccess: { state: 'ACTIVE_PAID', label: 'Paid plan', active: true },
});
const open = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page({ params: Promise.resolve({ id: 't1' }) })}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  door.open = true;
  writes.on = false;
  loadTenant.mockReset();
  loadTenant.mockResolvedValue({
    tenant: { ok: true, value: tenant },
    provisioning: null,
    plans: undefined,
    coupons: [],
    assignable: [],
  });
});

describe('★★ /system/tenants/[id]', () => {
  it('★★ not a system admin: not found, and nothing is read', async () => {
    door.open = false;
    await expect(Page({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadTenant).not.toHaveBeenCalled();
  });

  it('★ the tenant’s name as the title, in its own bdi; the way back to Tenants', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1 }).querySelector('bdi')).toHaveTextContent(
      'Acme',
    );
    expect(screen.getByRole('link', { name: 'Tenants' })).toHaveAttribute(
      'href',
      '/system/tenants',
    );
    for (const id of ['facts', 'billing-t1', 'coupons', 'controls']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('★★ billing writes off here: said before anyone presses anything', async () => {
    await open();
    expect(screen.getByTestId('billing-held')).toHaveTextContent('Billing writes are off');
  });

  it('billing writes on: no such line', async () => {
    writes.on = true;
    await open();
    expect(screen.queryByTestId('billing-held')).toBeNull();
  });

  it('★ a tenant that does not exist and one that could not be read: two sentences', async () => {
    loadTenant.mockResolvedValue({ tenant: { ok: false, missing: true } });
    const { unmount } = await open();
    expect(screen.getByTestId('tenant-unread')).toHaveTextContent(
      'There is no tenant with this address.',
    );
    unmount();
    loadTenant.mockResolvedValue({ tenant: { ok: false, missing: false } });
    await open();
    expect(screen.getByTestId('tenant-unread')).toHaveTextContent("couldn't be read");
  });
});
