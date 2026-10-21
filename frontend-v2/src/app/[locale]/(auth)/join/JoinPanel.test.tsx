import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/en/auth.json';

// ⚠ Nothing here joins anything: every answer is the test's own.
const acceptInvite = vi.hoisted(() => vi.fn());
vi.mock('@/features/join/actions', () => ({ acceptInvite }));

const { JoinPanel } = await import('./JoinPanel');

const go = vi.fn();
const show = (email: string | null = null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth }}>
      <JoinPanel
        token="tok-1"
        invitation={{ tenant: { name: 'Aviv Ceramics' }, email }}
        signInHref="/en/sign-in"
        go={go}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  acceptInvite.mockReset();
  go.mockReset();
});

describe('★★ /join - the invitation, accepted', () => {
  it('names the workspace, isolated as the inviter wrote it', () => {
    show();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Join Aviv Ceramics');
    expect(heading.querySelector('bdi')).toHaveTextContent(/^Aviv Ceramics$/);
  });

  it('★ a fixed address is shown and cannot be changed; an open link asks for one', async () => {
    const { unmount } = show('dana@aviv.co');
    expect(screen.getByTestId('join-email')).toHaveValue('dana@aviv.co');
    expect(screen.getByTestId('join-email')).toHaveAttribute('readonly');
    expect(screen.getByText('This invitation is for this address.')).toBeInTheDocument();
    unmount();
    show(null);
    expect(screen.getByTestId('join-email')).toHaveValue('');
    expect(screen.getByTestId('join-email')).not.toHaveAttribute('readonly');
    expect(screen.queryByText('This invitation is for this address.')).toBeNull();
  });

  it('Join stays off until there is a name and an address', async () => {
    show(null);
    const submit = screen.getByTestId('join-submit');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId('join-email'), 'dana@aviv.co');
    expect(submit).toBeEnabled();
  });

  it('★★ accepted with a setup link: the browser goes there, and the button stays busy', async () => {
    acceptInvite.mockResolvedValue({ ok: true, setupLink: 'https://x.co/api/auth/setup/s1' });
    show(null);
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    await userEvent.type(screen.getByTestId('join-email'), 'dana@aviv.co');
    await userEvent.click(screen.getByTestId('join-submit'));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://x.co/api/auth/setup/s1'));
    expect(acceptInvite).toHaveBeenCalledWith({
      token: 'tok-1',
      name: 'Dana',
      email: 'dana@aviv.co',
    });
    expect(screen.getByTestId('join-submit')).toBeDisabled();
    expect(screen.getByTestId('join-submit')).toHaveTextContent('Joining…');
  });

  it('a fixed address is the invitation’s own: none is sent', async () => {
    acceptInvite.mockResolvedValue({ ok: true, setupLink: 'https://x.co/s' });
    show('dana@aviv.co');
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    await userEvent.click(screen.getByTestId('join-submit'));
    await waitFor(() =>
      expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok-1', name: 'Dana' }),
    );
  });

  it('★★ accepted with no setup link (a password already exists): joined, and sign-in offered', async () => {
    acceptInvite.mockResolvedValue({ ok: true, setupLink: null });
    show('dana@aviv.co');
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    await userEvent.click(screen.getByTestId('join-submit'));
    expect(await screen.findByTestId('join-done')).toHaveTextContent('You joined Aviv Ceramics');
    expect(screen.getByTestId('join-sign-in')).toHaveAttribute('href', '/en/sign-in');
    expect(go).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 'This invitation can no longer be used.'],
    ['email_required', 'Enter your work email.'],
    ['already_member', 'That address is already a member of this workspace.'],
    ['invalid_input', 'Check your name and email address.'],
    ['failed', 'That did not go through.'],
  ])('★ a refusal (%s) is said, and the form is offered again', async (reason, words) => {
    acceptInvite.mockResolvedValue({ ok: false, reason });
    show('dana@aviv.co');
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    await userEvent.click(screen.getByTestId('join-submit'));
    expect(await screen.findByTestId('join-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('join-submit')).toBeEnabled();
    expect(go).not.toHaveBeenCalled();
  });

  it('⚠ one press, one request - a second press while it is in flight sends nothing', async () => {
    let answer: (value: unknown) => void = () => {};
    acceptInvite.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show('dana@aviv.co');
    await userEvent.type(screen.getByTestId('join-name'), 'Dana');
    const form = screen.getByTestId('join-form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    answer({ ok: true, setupLink: null });
    await screen.findByTestId('join-done');
    expect(acceptInvite).toHaveBeenCalledTimes(1);
  });

  it('the way to sign in is there for somebody who already has an account', () => {
    show(null);
    expect(screen.getByTestId('join-have-account')).toHaveAttribute('href', '/en/sign-in');
  });
});
