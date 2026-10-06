import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionDef } from '@/api/contracts/permission-catalog';
import { holds, type Person } from '@/api/contracts/roles';
import roles from '@/i18n/messages/en/roles.json';

const { addPermission } = vi.hoisted(() => ({
  addPermission: vi.fn(() => {
    throw new Error('a test must never call addPermission for real');
  }),
}));
vi.mock('./actions', () => ({ addPermission }));

beforeEach(() => {
  // Calls from the test before would be read as this one's.
  addPermission.mockClear();
});
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
      expiresAt: null,
      active: true,
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

  it('Ends is live (53a5079a): "No end date" by default; a date field only for "Pick a date"', async () => {
    picker();
    expect(screen.getByTestId('grant-ends-none')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('grant-ends-day')).toBeNull();
    await userEvent.click(screen.getByTestId('grant-ends-date'));
    expect(screen.getByTestId('grant-ends-day')).toBeInTheDocument();
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
    // No end date: `null`, sent — the PUT replaces the override whole.
    expect(addPermission).toHaveBeenCalledWith('u1', 'customer:export:run', 'Friday shifts', null);
  });

  it('★ "30 days": the end of that day in the workspace’s zone, sent with each', async () => {
    addPermission.mockResolvedValue({ ok: true } as never);
    picker();
    await userEvent.click(
      screen.getByTestId('grant-option-customer:export:run').querySelector('input')!,
    );
    await userEvent.click(screen.getByTestId('grant-ends-days30'));
    await userEvent.click(screen.getByTestId('grant-add'));
    const sent = (addPermission.mock.calls[0] as unknown[])[3] as string;
    // 23:59:59 in Israel is 20:59:59 or 21:59:59 UTC, never midday.
    expect(sent).toMatch(/T2[01]:59:59\.000Z$/);
    const days = (new Date(sent).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31.1);
  });

  it('"Pick a date" waits for one; a past date is the server’s to refuse, and said', async () => {
    addPermission.mockResolvedValue({ ok: false, reason: 'past_date' } as never);
    picker();
    await userEvent.click(
      screen.getByTestId('grant-option-customer:export:run').querySelector('input')!,
    );
    await userEvent.click(screen.getByTestId('grant-ends-date'));
    expect(screen.getByTestId('grant-add')).toBeDisabled();
    await userEvent.type(screen.getByTestId('grant-ends-day'), '2099-01-31');
    await userEvent.click(screen.getByTestId('grant-add'));
    expect((addPermission.mock.calls[0] as unknown[])[3]).toMatch(/^2099-01-31T2[01]:59:59/);
    expect(await screen.findByTestId('grant-problem')).toHaveTextContent('already passed');
  });
});
