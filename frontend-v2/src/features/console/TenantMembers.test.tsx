import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tenantMemberSchema } from '@/api/contracts/console';
import consoleEn from '@/i18n/messages/en/console.json';

/** A tenant's members, edited by hand. Mocked: nothing is sent, nobody is emailed. */
const { edit, refresh } = vi.hoisted(() => ({
  edit: { addMember: vi.fn(), changeMemberEmail: vi.fn(), removeMember: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('./edit-actions', () => edit);
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { TenantMembers } from './TenantMembers';

const members = [
  { id: 'u1', name: 'Dana Levi', email: 'dana@acme.co', role: 'ADMIN', isActive: true },
  { id: 'u2', name: '', email: 'noa@acme.co', role: 'AGENT', isActive: false },
  { id: 'u3', name: 'Platform', email: 'admin@gotcha.co.il', role: 'SYSTEM_ADMIN', isActive: true },
].map((member) => tenantMemberSchema.parse(member));

const show = (list: Parameters<typeof TenantMembers>[0]['members'] = members) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
      <TenantMembers tenantId="t1" members={list} />
    </NextIntlClientProvider>,
  );
const row = (id: string) => within(screen.getByTestId(`member-${id}`));
const reason = (value = 'per the customer') =>
  fireEvent.change(screen.getByLabelText(consoleEn.edit.reason), { target: { value } });

beforeEach(() => {
  for (const each of Object.values(edit)) {
    each.mockReset();
    each.mockResolvedValue({ ok: true, warnings: [] });
  }
  refresh.mockClear();
});

describe('★★ a tenant’s owners and users', () => {
  it('★ each member: name (or the email when nameless), email, role in the app’s words', () => {
    show();
    expect(row('u1').getByText('Dana Levi')).toBeInTheDocument();
    expect(row('u1').getByText('Owner')).toBeInTheDocument();
    expect(screen.getByTestId('member-u2')).toHaveTextContent('Agent · Inactive');
    expect(row('u2').getAllByText('noa@acme.co')).toHaveLength(2);
  });

  it('★★ a platform administrator is shown and offered no edit', () => {
    show();
    expect(screen.getByTestId('member-u3')).toHaveTextContent('Platform administrator');
    expect(row('u3').queryAllByRole('button')).toHaveLength(0);
  });

  it('★ unread is said, and no add form is offered on a list nobody read', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ console: consoleEn }}>
        <TenantMembers tenantId="t1" members={undefined} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('members-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('member-add')).toBeNull();
  });

  it('★★ change email: a valid, DIFFERENT address, confirmed with a reason', async () => {
    show();
    fireEvent.click(screen.getByTestId('member-email-open-u1'));
    const field = screen.getByTestId('member-email-u1');
    const save = screen.getByTestId('member-email-save-u1-open');
    fireEvent.change(field, { target: { value: 'not-an-email' } });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: ' DANA@acme.co ' } });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: 'dana@acme.io' } });
    fireEvent.click(save);
    expect(screen.getByRole('group')).toHaveTextContent(
      'Dana Levi signs in with dana@acme.io from now on. Their password and open sessions stay as they are.',
    );
    reason();
    await act(async () => fireEvent.click(screen.getByTestId('member-email-save-u1-yes')));
    expect(edit.changeMemberEmail).toHaveBeenCalledWith(
      't1',
      'u1',
      'dana@acme.io',
      'per the customer',
    );
    expect(screen.getByRole('status')).toHaveTextContent('The email is now dana@acme.io.');
  });

  it('★★ a shared login is refused with the way round it', async () => {
    edit.changeMemberEmail.mockResolvedValue({ ok: false, reason: 'identity_shared' });
    show();
    fireEvent.click(screen.getByTestId('member-email-open-u1'));
    fireEvent.change(screen.getByTestId('member-email-u1'), { target: { value: 'x@acme.io' } });
    fireEvent.click(screen.getByTestId('member-email-save-u1-open'));
    reason();
    await act(async () => fireEvent.click(screen.getByTestId('member-email-save-u1-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Add the new email as a user instead, then remove this member.',
    );
  });

  it('★★ remove: a danger confirm with a reason, saying what stays', async () => {
    show();
    fireEvent.click(screen.getByTestId('member-remove-u2-open'));
    expect(screen.getByRole('group')).toHaveTextContent(
      'noa@acme.co is removed from this tenant and can no longer sign in to it. Their conversations stay, unassigned.',
    );
    expect(screen.getByTestId('member-remove-u2-yes')).toBeDisabled();
    reason('left');
    await act(async () => fireEvent.click(screen.getByTestId('member-remove-u2-yes')));
    expect(edit.removeMember).toHaveBeenCalledWith('t1', 'u2', 'left');
  });

  it('★ the only owner: the route’s refusal is said', async () => {
    edit.removeMember.mockResolvedValue({ ok: false, reason: 'last_admin' });
    show();
    fireEvent.click(screen.getByTestId('member-remove-u1-open'));
    reason();
    await act(async () => fireEvent.click(screen.getByTestId('member-remove-u1-yes')));
    expect(screen.getByRole('alert')).toHaveTextContent("This is the tenant's only owner.");
  });

  it('★★ add: name, a valid email not already a member, a role; confirmed with a reason', async () => {
    show();
    const add = screen.getByTestId('member-add-submit-open');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Yoni' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' Dana@ACME.co' } });
    expect(add).toBeDisabled();
    expect(screen.getByTestId('member-add')).toHaveTextContent(
      consoleEn.edit.refusal.already_member,
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'yoni@acme.co' } });
    fireEvent.change(screen.getByTestId('member-add-role'), { target: { value: 'ADMIN' } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(screen.getByRole('group')).toHaveTextContent(
      'yoni@acme.co is added as Owner and emailed a link to set up their account.',
    );
    reason('new owner');
    await act(async () => fireEvent.click(screen.getByTestId('member-add-submit-yes')));
    expect(edit.addMember).toHaveBeenCalledWith(
      't1',
      { email: 'yoni@acme.co', name: 'Yoni', role: 'ADMIN' },
      'new owner',
    );
    expect(screen.getByRole('status')).toHaveTextContent('yoni@acme.co was added');
  });

  it('a new user is an Agent unless chosen otherwise', () => {
    show();
    expect(screen.getByTestId('member-add-role')).toHaveValue('AGENT');
  });
});
