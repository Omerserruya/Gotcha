import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { roleSchema } from '@/api/contracts/roles';
import people from '@/i18n/messages/en/people.json';
import roles from '@/i18n/messages/en/roles.json';
import { PermissionsProvider } from '@/permissions/permissions-context';

// ⚠ Nothing here invites anyone: the action throws if it is ever reached.
vi.mock('./actions', () => ({
  inviteMember: vi.fn(async () => {
    throw new Error('a test must never invite anyone');
  }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { InviteForm } from './InviteForm';

const teams = [{ id: 't1', name: 'Support' }] as never;
const show = (open: boolean) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ people, roles }}>
      <InviteForm teams={teams} open={open} />
    </NextIntlClientProvider>,
  );

describe('★ 12 - the invite is one inline row, opened from the header', () => {
  it('closed, it is nothing - the header holds "Invite someone"', () => {
    const { container } = show(false);
    expect(container).toBeEmptyDOMElement();
  });

  it('open: email, name, role, team, Send invite, Cancel - on one row', () => {
    show(true);
    const row = screen.getByTestId('invite-form').firstElementChild!;
    expect(row).toContainElement(screen.getByLabelText('Email'));
    expect(row).toContainElement(screen.getByTestId('invite-role'));
    expect(row).toContainElement(screen.getByTestId('invite-team'));
    expect(row).toContainElement(screen.getByTestId('invite-send'));
    expect(screen.getByTestId('invite-cancel')).toHaveAttribute('href', '/settings/people');
  });

  it('★ no roles read: the role is the agent default alone - an invite without a role', () => {
    show(true);
    const role = screen.getByTestId('invite-role') as HTMLSelectElement;
    expect(role.tagName).toBe('SELECT');
    expect([...role.options].map((o) => [o.value, o.text])).toEqual([['', 'Agent']]);
  });

  it('no team by default; the teams are there to tick (Omer, 12: several at once)', () => {
    show(true);
    const team = screen.getByTestId('invite-team');
    expect(team.querySelector('summary')).toHaveTextContent('No team');
    expect(team).toHaveTextContent('Support');
  });
});

describe('★★ 12 - invited into several teams at once (Omer)', () => {
  it('ticked teams all go with the invite; the summary counts them', async () => {
    const { inviteMember } = await import('./actions');
    // This one invite is answered, so the press can be watched - it still reaches no one.
    vi.mocked(inviteMember)
      .mockReset()
      .mockResolvedValue({ ok: true, data: {} } as never);
    render(
      <NextIntlClientProvider locale="en" messages={{ people, roles }}>
        <InviteForm
          teams={
            [
              { id: 't1', name: 'Support' },
              { id: 't2', name: 'Sales' },
            ] as never
          }
          open
        />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByTestId('invite-team-t1'));
    await userEvent.click(screen.getByTestId('invite-team-t2'));
    expect(screen.getByTestId('invite-team').querySelector('summary')).toHaveTextContent('2 teams');
    await userEvent.type(document.getElementById('invite-email')!, 'tomer@avivco.il');
    await userEvent.type(document.getElementById('invite-name')!, 'Tomer');
    await userEvent.click(screen.getByTestId('invite-send'));
    expect(inviteMember).toHaveBeenCalledWith({
      email: 'tomer@avivco.il',
      name: 'Tomer',
      departmentIds: ['t1', 't2'],
      role: null,
    });
  });
});

/* ── G5: choosing a role when inviting (auth 679b8812) ─────────────────── */

const role = (id: string, name: string, features: string[], builtinKey: string | null = null) =>
  roleSchema.parse({ id, name, features, builtinKey, isSystem: builtinKey !== null });
const ROLES = [
  role('r-owner', 'Owner', ['*'], 'owner'),
  role('r-admin', 'Admin', ['crm:contacts:read', 'billing:invoices:read'], 'admin'),
  role('r-agent', 'Agent', ['crm:contacts:read'], 'agent'),
  role('r-desk', 'Refunds desk', ['crm:contacts:read', 'customer:commerce:refund']),
];
const CATALOG = ['crm:contacts:read', 'billing:invoices:read', 'customer:commerce:refund'];

const invite = (held: string[], roleKey?: string) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ people, roles }}>
      <PermissionsProvider permissions={held} roleKey={roleKey} tenantId="t">
        <InviteForm teams={teams} open roles={ROLES} catalog={CATALOG} />
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );
const options = () =>
  [...(screen.getByTestId('invite-role') as HTMLSelectElement).options].map((o) => o.text);
const fillAndSend = async () => {
  await userEvent.type(document.getElementById('invite-email')!, 'dana@avivco.il');
  await userEvent.type(document.getElementById('invite-name')!, 'Dana');
  await userEvent.click(screen.getByTestId('invite-send'));
};

describe('★★ G5 - the invite takes a role, from those the inviter may give', () => {
  it('only roles whose every permission the inviter holds; Owner hidden from a non-owner', () => {
    invite(['crm:contacts:read', 'customer:commerce:refund'], 'admin');
    expect(options()).toEqual(['Agent', 'Refunds desk']);
  });

  it('an Owner sees every role, Owner included - never the merged Admin (auth 30d610da)', () => {
    invite([], 'owner');
    expect(options()).toEqual(['Owner', 'Agent', 'Refunds desk']);
  });

  it('starts on the agent role, and sends the role chosen', async () => {
    const { inviteMember } = await import('./actions');
    vi.mocked(inviteMember)
      .mockReset()
      .mockResolvedValue({ ok: true, data: {} } as never);
    invite(['crm:contacts:read', 'customer:commerce:refund'], 'admin');
    const select = screen.getByTestId('invite-role') as HTMLSelectElement;
    expect(select.value).toBe('r-agent');
    await userEvent.selectOptions(select, 'r-desk');
    await fillAndSend();
    expect(inviteMember).toHaveBeenCalledWith(expect.objectContaining({ role: 'r-desk' }));
  });

  it('untouched, the agent role is what is sent', async () => {
    const { inviteMember } = await import('./actions');
    vi.mocked(inviteMember)
      .mockReset()
      .mockResolvedValue({ ok: true, data: {} } as never);
    invite(['crm:contacts:read'], 'admin');
    await fillAndSend();
    expect(inviteMember).toHaveBeenCalledWith(expect.objectContaining({ role: 'r-agent' }));
  });
});

describe('★★ G5 - each refusal is a sentence, and says nobody was invited', () => {
  it.each([
    [
      'above_own_role, named in the grid’s words',
      { ok: false, reason: 'above_own_role', missing: ['customer:commerce:refund'] },
      /You can't give permissions you don't hold yourself: .+\. Nothing was changed\./,
    ],
    [
      'above_own_role, a key with no words',
      { ok: false, reason: 'above_own_role', missing: ['x:y:z'] },
      new RegExp(roles.ceiling.aboveOwnUnnamed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    ],
    ['owner_only', { ok: false, reason: 'owner_only' }, /Only an Owner can give the Owner role/],
    ['unknown_role', { ok: false, reason: 'unknown_role' }, /nobody was invited/],
  ])('%s', async (_name, outcome, sentence) => {
    const { inviteMember } = await import('./actions');
    vi.mocked(inviteMember)
      .mockReset()
      .mockResolvedValue(outcome as never);
    invite(['crm:contacts:read'], 'admin');
    await fillAndSend();
    const note = await screen.findByTestId('invite-note');
    expect(note).toHaveAttribute('data-note-kind', 'problem');
    expect(note).toHaveTextContent(sentence);
    expect(note).not.toHaveTextContent(/:[a-z]+:/);
    expect(screen.queryByTestId('invite-link')).toBeNull();
  });
});
