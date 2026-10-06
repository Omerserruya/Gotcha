import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import approvals from '@/i18n/messages/en/approvals.json';
import customers from '@/i18n/messages/en/customers.json';

/* Approving moves money: the writes are spies, and nothing here reaches the platform. */
const approveRequest = vi.hoisted(() => vi.fn());
const rejectRequest = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/features/approvals/actions', () => ({ approveRequest, rejectRequest }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { DecideHere } from './DecideHere';

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ customers, approvals }}>
      <DecideHere approvalId="a1" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  approveRequest.mockReset();
  rejectRequest.mockReset();
  refresh.mockReset();
});

describe('★★ 04e - a pending action decided where it is read', () => {
  it('Approve asks first; yes approves, and says whether it RAN', async () => {
    approveRequest.mockResolvedValue({ ok: true, dispatched: false, dispatchError: 'x' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('decide-approve-a1'));
    expect(approveRequest).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('decide-yes-a1'));
    expect(approveRequest).toHaveBeenCalledWith('a1');
    expect(screen.getByTestId('decided-here-a1')).toHaveTextContent('didn’t run');
    expect(refresh).toHaveBeenCalled();
  });

  it('Decline takes 03’s reasons, sent as their label; Change amount opens 03', async () => {
    rejectRequest.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    show();
    expect(screen.getByRole('link', { name: 'Change amount' })).toHaveAttribute(
      'href',
      '/approvals',
    );
    await user.click(screen.getByTestId('decide-decline-a1'));
    await user.click(screen.getByTestId('decide-reason-policy-a1'));
    expect(rejectRequest).toHaveBeenCalledWith('a1', 'Outside policy');
    expect(screen.getByTestId('decided-here-a1')).toHaveTextContent('Declined.');
  });

  it('already decided by someone else: said, nothing refreshed', async () => {
    approveRequest.mockResolvedValue({ ok: false, reason: 'stale' });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByTestId('decide-approve-a1'));
    await user.click(screen.getByTestId('decide-yes-a1'));
    expect(screen.getByRole('alert')).toHaveTextContent('Someone already decided this one.');
    expect(refresh).not.toHaveBeenCalled();
  });
});
