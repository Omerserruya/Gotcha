import { render, screen } from '@testing-library/react';
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

describe('★ 12 — the invite is one inline row, opened from the header', () => {
  it('closed, it is nothing — the header holds "Invite someone"', () => {
    const { container } = show(false);
    expect(container).toBeEmptyDOMElement();
  });

  it('open: email, name, role, team, Send invite, Cancel — on one row', () => {
    show(true);
    const row = screen.getByTestId('invite-form').firstElementChild!;
    expect(row).toContainElement(screen.getByLabelText('Email'));
    expect(row).toContainElement(screen.getByTestId('invite-role'));
    expect(row).toContainElement(screen.getByTestId('invite-team'));
    expect(row).toContainElement(screen.getByTestId('invite-send'));
    expect(screen.getByTestId('invite-cancel')).toHaveAttribute('href', '/settings/people');
  });

  it('★ the role is the one the route gives — Agent, fixed — and says why', () => {
    show(true);
    const role = screen.getByTestId('invite-role');
    expect(role).toBeDisabled();
    expect(role).toHaveTextContent('Agent');
    expect(role).toHaveAttribute('title', expect.stringMatching(/takes no role/i));
  });

  it('one team, or none by default', () => {
    show(true);
    const team = screen.getByTestId('invite-team') as HTMLSelectElement;
    expect(team.value).toBe('');
    expect(team).toHaveTextContent('No team');
    expect(team).toHaveTextContent('Support');
  });
});
