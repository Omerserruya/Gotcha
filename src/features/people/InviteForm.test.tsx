import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import people from '@/i18n/messages/en/people.json';

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
    <NextIntlClientProvider locale="en" messages={{ people }}>
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

  it('★ the role is the one the route gives - Agent, fixed - and says why', () => {
    show(true);
    const role = screen.getByTestId('invite-role');
    expect(role).toHaveAttribute('aria-disabled', 'true');
    expect(role).toHaveTextContent('Agent');
    expect(role).toHaveAttribute('title', expect.stringMatching(/takes no role/i));
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
      <NextIntlClientProvider locale="en" messages={{ people }}>
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
    });
  });
});
