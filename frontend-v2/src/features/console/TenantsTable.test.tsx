import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { tenantRowSchema, type ProvisioningStatus } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';
import consoleHe from '@/i18n/messages/he/console.json';

import { TenantsTable } from './TenantsTable';

const tenant = (id: string, over: Record<string, unknown> = {}) =>
  tenantRowSchema.parse({
    id,
    name: `Org ${id}`,
    slug: `org-${id}`,
    status: 'ACTIVE',
    isActive: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    _count: { users: 4, conversations: 2, channelAccounts: 1 },
    planAccess: { state: 'ACTIVE_PAID', label: 'Paid plan', active: true, needsReview: false },
    ...over,
  });
const request = (state: string): ProvisioningStatus => ({
  id: 'p',
  state,
  mode: 'PAID_PLAN',
  attemptCount: 1,
  lastAttemptAt: null,
  lastFailureCode: null,
  lastFailureMessage: null,
  canRepair: true,
  canResend: false,
});

const show = (
  props: Partial<Parameters<typeof TenantsTable>[0]> & {
    tenants: Parameters<typeof TenantsTable>[0]['tenants'];
  },
  locale: 'en' | 'he' = 'en',
) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ console: locale === 'he' ? consoleHe : consoleEn }}
    >
      <TenantsTable total={props.tenants.length} provisioning={{}} search="" {...props} />
    </NextIntlClientProvider>,
  );

const rowOf = (id: string) => screen.getByTestId(`tenant-${id}`);

describe('★★ the tenants table', () => {
  it('★ each row: name, slug, the counts, the plan and the status', () => {
    show({ tenants: [tenant('a')] });
    const row = rowOf('a');
    expect(row).toHaveTextContent('Org a');
    expect(row).toHaveTextContent('org-a');
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Org aorg-a', '4', '2', '1', 'Paid plan', 'Active']);
  });

  it('★★ a plan is never blank: no verdict reads "Plan unknown", no plan reads as needing action', () => {
    show({
      tenants: [
        tenant('a', { planAccess: null }),
        tenant('b', { planAccess: { state: 'MISSING', label: 'Missing plan, requires action' } }),
        tenant('c', { planAccess: { state: 'CONFLICTING', label: 'x' } }),
      ],
    });
    expect(within(rowOf('a')).getByTestId('tenant-plan')).toHaveTextContent(/^Plan unknown$/);
    expect(within(rowOf('b')).getByTestId('tenant-plan')).toHaveTextContent(
      /^No plan, needs action$/,
    );
    expect(within(rowOf('c')).getByTestId('tenant-plan')).toHaveTextContent(
      /^Two active plans, needs review$/,
    );
  });

  it('a plan state this build does not name: the route’s own label, as data', () => {
    show({ tenants: [tenant('a', { planAccess: { state: 'ACTIVE_GRANT', label: 'Grant' } })] });
    expect(within(rowOf('a')).getByTestId('plan-unnamed')).toHaveTextContent(/^Grant$/);
  });

  it('★★ awaiting payment: the tenant’s own request decides which problem it is', () => {
    show({
      tenants: [
        tenant('ready', { status: 'PENDING_PAYMENT' }),
        tenant('none', { status: 'PENDING_PAYMENT' }),
        tenant('failed', { status: 'PENDING_PAYMENT' }),
        tenant('unread', { status: 'PENDING_PAYMENT' }),
      ],
      provisioning: {
        ready: request('COMPLETED'),
        none: null,
        failed: request('FAILED_RETRYABLE'),
      },
    });
    const status = (id: string) => within(rowOf(id)).getByTestId('tenant-status');
    expect(status('ready')).toHaveTextContent(/^Pending payment$/);
    expect(status('none')).toHaveTextContent(/^Billing setup incomplete$/);
    expect(status('failed')).toHaveTextContent(/^Billing setup incomplete$/);
    expect(status('unread')).toHaveTextContent(/^Billing state unread$/);
  });

  it('★ disabled outranks the status - a disabled ACTIVE tenant cannot sign in', () => {
    show({ tenants: [tenant('a', { isActive: false })] });
    expect(within(rowOf('a')).getByTestId('tenant-status')).toHaveTextContent(/^Disabled$/);
  });

  it('a count the route did not send is "-", never 0', () => {
    show({ tenants: [tenant('a', { _count: undefined })] });
    const cells = within(rowOf('a')).getAllByRole('cell');
    expect(cells.slice(1, 4).map((c) => c.textContent)).toEqual(['-', '-', '-']);
  });

  it('★ more than one page: says how many it is showing of how many', () => {
    show({ tenants: [tenant('a'), tenant('b')], total: 75 });
    expect(screen.getByTestId('tenants-shown')).toHaveTextContent(
      'Showing the newest 2 of 75. Search to find the others.',
    );
  });

  it('one page: no count line', () => {
    show({ tenants: [tenant('a')] });
    expect(screen.queryByTestId('tenants-shown')).toBeNull();
  });

  it('★ empty, and a search that matches nothing, are two sentences', () => {
    const { unmount } = show({ tenants: [] });
    expect(screen.getByTestId('tenants-empty')).toHaveTextContent('There are no tenants yet.');
    unmount();
    show({ tenants: [], search: 'acme' });
    expect(screen.getByTestId('tenants-empty')).toHaveTextContent('contains “acme”');
  });

  it('in Hebrew', () => {
    show({ tenants: [tenant('a', { planAccess: null })] }, 'he');
    expect(within(rowOf('a')).getByTestId('tenant-plan')).toHaveTextContent('תוכנית לא ידועה');
    expect(within(rowOf('a')).getByTestId('tenant-status')).toHaveTextContent('פעיל');
  });
});
