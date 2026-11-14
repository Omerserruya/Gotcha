import { cleanup, render, screen } from '@testing-library/react';
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
vi.mock('@/features/console/load-tenants', () => ({
  loadCreateOptions: async () => ({ plans: [], domains: ['ai'] }),
}));
vi.mock('@/features/console/TenantPlanEdit', () => ({
  TenantPlanEdit: ({ plans, domains }: { plans?: unknown[]; domains?: string[] }) => (
    <div data-testid="plan-edit">{`${plans === undefined ? 'unread' : plans.length}|${domains?.join(',')}`}</div>
  ),
}));
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
  TenantControls: ({ planActive }: { planActive: boolean }) => (
    <div data-testid="controls" data-plan-active={String(planActive)} />
  ),
}));
vi.mock('@/features/console/TenantDelete', () => ({
  TenantDelete: ({ slug }: { slug: string }) => <div data-testid="delete">{slug}</div>,
}));
vi.mock('@/features/support/SupportEnter', () => ({
  SupportEnter: ({ tenantId, ended }: { tenantId: string; ended: boolean }) => (
    <div data-testid="support-enter" data-tenant={tenantId} data-ended={String(ended)} />
  ),
}));
vi.mock('@/features/console/TenantMembers', () => ({
  TenantMembers: ({ members }: { members?: readonly { email: string }[] }) => (
    <div data-testid="members">
      {members === undefined ? 'unread' : members.map((m) => m.email).join(',')}
    </div>
  ),
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
  users: [{ id: 'u1', name: 'Dana', email: 'dana@acme.co', role: 'ADMIN', isActive: true }],
});
const open = async (query: { support?: string } = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      {await Page({ params: Promise.resolve({ id: 't1' }), searchParams: Promise.resolve(query) })}
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
    await expect(
      Page({ params: Promise.resolve({ id: 't1' }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
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
    const ids = ['facts', 'billing-t1', 'coupons', 'controls', 'plan-edit', 'members', 'delete'];
    for (const id of ids) expect(screen.getByTestId(id)).toBeInTheDocument();
    // The delete is the LAST card on the page.
    const cards = [...document.querySelectorAll('[data-testid]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(cards.at(-1)).toBe('delete');
    expect(screen.getByTestId('delete')).toHaveTextContent('acme');
    // The plan card gets the provisionable plans and POC areas as read.
    expect(screen.getByTestId('plan-edit')).toHaveTextContent('0|ai');
  });

  it('★ the members are the detail’s own list; the plan says whether a status is enough', async () => {
    await open();
    expect(screen.getByTestId('members')).toHaveTextContent('dana@acme.co');
    expect(screen.getByTestId('controls')).toHaveAttribute('data-plan-active', 'true');
  });

  it('★ a members list the detail could not read stays unread, never "none"', () => {
    expect(tenantDetailSchema.parse({ ...tenant, users: 'garbage' }).users).toBeUndefined();
    expect(tenantDetailSchema.parse({ ...tenant, users: undefined }).users).toBeUndefined();
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

  it('★★ support mode can be entered from here; back from an ended session, it says so', async () => {
    await open();
    expect(screen.getByTestId('support-enter')).toHaveAttribute('data-tenant', 't1');
    expect(screen.getByTestId('support-enter')).toHaveAttribute('data-ended', 'false');
    cleanup();
    await open({ support: 'ended' });
    expect(screen.getByTestId('support-enter')).toHaveAttribute('data-ended', 'true');
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
