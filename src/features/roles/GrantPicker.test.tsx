import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import { holds, type Person } from '@/api/contracts/roles';
import roles from '@/i18n/messages/en/roles.json';

const { addPermission } = vi.hoisted(() => ({
  addPermission: vi.fn(() => {
    throw new Error('a test must never call addPermission for real');
  }),
}));
vi.mock('./actions', () => ({ addPermission }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { GrantPicker } from './GrantPicker';

const def = (key: string, domain: string, displayName: string): PermissionDef => ({
  key,
  domain,
  feature: '',
  subFeature: '',
  action: '',
  scoped: false,
  displayName,
  description: '',
});

const CATALOG = [
  def('conversation:messages:reply', 'conversation', 'Reply, note, close'),
  def('conversation:assign:any', 'conversation', 'Reassign any conversation'),
  def('approvals:refund:approve', 'approvals', 'Approve AI refunds'),
  def('customer:export:run', 'customer', 'Export customer list'),
];

const TOMER: Person = {
  id: 'u1',
  name: 'Tomer Adler',
  email: 'tomer@example.com',
  role: 'AGENT',
  roles: [],
  grants: [
    {
      feature: 'approvals:refund:approve',
      granted: true,
      reason: null,
      updatedBy: null,
      updatedAt: null,
    },
  ],
  permissions: ['conversation:messages:*', 'approvals:refund:approve'],
  scope: 'team',
};

const picker = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ roles }}>
      <GrantPicker person={TOMER} permissions={CATALOG} roleName="Agent" />
    </NextIntlClientProvider>,
  );

describe('★ the wildcard semantic, as the catalogue states it', () => {
  it('a pattern covers the keys under it, and only those', () => {
    expect(holds(['conversation:messages:*'], 'conversation:messages:reply')).toBe(true);
    expect(holds(['conversation:messages:*'], 'conversation:assign:any')).toBe(false);
    expect(holds(['*'], 'anything:at:all')).toBe(true);
  });
});

describe('★ 12e — what is already covered is shown and cannot be picked', () => {
  it('"Already given" for an extra permission, "In Agent" for one the role carries', () => {
    picker();
    const given = screen.getByTestId('grant-option-approvals:refund:approve');
    expect(given).toHaveTextContent('Already given');
    expect(given.querySelector('input')).toBeDisabled();
    const inRole = screen.getByTestId('grant-option-conversation:messages:reply');
    expect(inRole).toHaveTextContent('In Agent');
    expect(inRole.querySelector('input')).toBeDisabled();
    expect(
      screen.getByTestId('grant-option-conversation:assign:any').querySelector('input'),
    ).toBeEnabled();
  });

  it('the search narrows by name', async () => {
    picker();
    await userEvent.type(screen.getByTestId('grant-search'), 'export');
    expect(screen.queryByTestId('grant-option-conversation:assign:any')).toBeNull();
    expect(screen.getByTestId('grant-option-customer:export:run')).toBeInTheDocument();
  });

  it('only "No end date" is live: nothing stores an end', () => {
    picker();
    expect(screen.getByText('7 days')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('No end date')).toHaveAttribute('data-current', 'yes');
  });

  it('Add waits for a pick', () => {
    picker();
    expect(screen.getByTestId('grant-add')).toBeDisabled();
  });
});

describe('★ 12e corrections (measurement of 9121d4f)', () => {
  it('an all-covered list explains itself: "Owner already allows everything."', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ roles }}>
        <GrantPicker
          person={{ ...TOMER, permissions: ['*'] }}
          permissions={CATALOG}
          roleName="Owner"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('grant-all-covered')).toHaveTextContent(
      'Owner already allows everything.',
    );
  });

  it('several at once: one call each, in order, with the one reason', async () => {
    const calls: string[] = [];
    addPermission.mockImplementation((async (_u: string, key: string) => {
      calls.push(key);
      return { ok: true };
    }) as never);
    picker();
    await userEvent.click(
      screen.getByTestId('grant-option-conversation:assign:any').querySelector('input')!,
    );
    await userEvent.click(
      screen.getByTestId('grant-option-customer:export:run').querySelector('input')!,
    );
    await userEvent.type(screen.getByTestId('grant-reason'), 'Friday shifts');
    await userEvent.click(screen.getByTestId('grant-add'));
    expect(await screen.findByTestId('grant-done')).toBeInTheDocument();
    expect(calls).toEqual(['conversation:assign:any', 'customer:export:run']);
    expect(addPermission).toHaveBeenCalledWith('u1', 'customer:export:run', 'Friday shifts');
  });
});
