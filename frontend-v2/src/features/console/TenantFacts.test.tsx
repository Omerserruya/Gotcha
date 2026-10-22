import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { tenantDetailSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

import { TenantFacts } from './TenantFacts';

const tenant = (over: object = {}) =>
  tenantDetailSchema.parse({
    id: 't1',
    name: 'Acme',
    slug: 'acme',
    status: 'PENDING_PAYMENT',
    isActive: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    _count: { users: 3, conversations: 9, messages: 80, channelAccounts: 2, departments: 1 },
    channels: [
      { id: 'c1', channel: 'WHATSAPP', displayName: 'Acme WA', connectionStatus: 'CONNECTED' },
      { id: 'c2', channel: 'INSTAGRAM', displayName: null, connectionStatus: 'ERROR' },
    ],
    planAccess: { state: 'PENDING_PAYMENT', label: 'Pending payment' },
    ...over,
  });

const show = (t = tenant(), provisioning?: Parameters<typeof TenantFacts>[0]['provisioning']) =>
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: consoleEn }}>
      <TenantFacts tenant={t} provisioning={provisioning} />
    </NextIntlClientProvider>,
  );

describe('★ the tenant’s facts', () => {
  it('the route’s counts, each by name; one it did not send is "-"', () => {
    show(tenant({ _count: { users: 3, conversations: 9, messages: 80, channelAccounts: 2 } }));
    expect(screen.getByTestId('count-messages')).toHaveTextContent(/^80$/);
    expect(screen.getByTestId('count-teams')).toHaveTextContent(/^-$/);
  });

  it('★ the status uses the same billing rule as the list: unread provisioning is unread', () => {
    show(tenant(), undefined);
    expect(screen.getByTestId('detail-status')).toHaveTextContent('Billing state unread');
  });

  it('channels: connected or not, by the route’s own status', () => {
    show();
    const list = screen.getByRole('list', { name: 'Channels' });
    expect(list).toHaveTextContent('Acme WA');
    expect(list.children[0]).toHaveTextContent(/Connected$/);
    expect(list.children[1]).toHaveTextContent(/Not connected$/);
  });
});
