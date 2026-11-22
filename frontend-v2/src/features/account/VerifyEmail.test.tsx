import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import security from '@/i18n/messages/en/security.json';

// ⚠ Nothing here changes an address: every answer is the test's own.
const verifyEmailChange = vi.hoisted(() => vi.fn());
vi.mock('./verify-email-action', () => ({ verifyEmailChange }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { VerifyEmail } = await import('./VerifyEmail');

const show = (token: string | null) =>
  render(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={{ security }}>
        <VerifyEmail token={token} />
      </NextIntlClientProvider>
    </StrictMode>,
  );

beforeEach(() => {
  verifyEmailChange.mockReset();
});

describe('★★ /account/verify-email - opening the link confirms it', () => {
  it('★ confirms once on open - even under a double effect - and says so while it works', async () => {
    let answer: (value: unknown) => void = () => {};
    verifyEmailChange.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show('t.sig');
    expect(screen.getByTestId('verify-email-working')).toHaveTextContent(
      'Confirming your new email…',
    );
    answer({ ok: true, email: 'new@aviv.co' });
    await screen.findByTestId('verify-email-done');
    expect(verifyEmailChange).toHaveBeenCalledTimes(1);
    expect(verifyEmailChange).toHaveBeenCalledWith('t.sig');
  });

  it('★★ done: the new address, isolated left-to-right, and the way on', async () => {
    verifyEmailChange.mockResolvedValue({ ok: true, email: 'new@aviv.co' });
    show('t.sig');
    const done = await screen.findByTestId('verify-email-done');
    expect(done).toHaveTextContent('Email updated');
    const address = done.querySelector('bdi');
    expect(address).toHaveTextContent(/^new@aviv\.co$/);
    expect(address).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('link', { name: 'Continue to GOTCHA' })).toHaveAttribute(
      'href',
      '/home',
    );
  });

  it('no token: says the link is incomplete, and asks nothing', () => {
    show(null);
    expect(screen.getByTestId('verify-email-refused')).toHaveAttribute('data-reason', 'missing');
    expect(screen.getByTestId('verify-email-refused')).toHaveTextContent(
      'missing its confirmation code',
    );
    expect(screen.queryByTestId('verify-email-retry')).toBeNull();
    expect(verifyEmailChange).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 'has expired or is not valid', false],
    ['wrong_account', 'belongs to a different account', false],
    ['taken', 'already in use by another account', false],
    ['unfinished', 'nothing was changed', true],
    ['failed', 'That did not go through', true],
  ])(
    '★ refused (%s): said - and a retry only where nothing is wrong with the link',
    async (reason, words, retry) => {
      verifyEmailChange.mockResolvedValue({ ok: false, reason });
      show('t.sig');
      const refused = await screen.findByTestId('verify-email-refused');
      expect(refused).toHaveAttribute('data-reason', reason);
      expect(refused).toHaveTextContent(words);
      expect(screen.queryByTestId('verify-email-retry') !== null).toBe(retry);
    },
  );

  it('★ retry asks again, and a success replaces the refusal', async () => {
    verifyEmailChange
      .mockResolvedValueOnce({ ok: false, reason: 'unfinished' })
      .mockResolvedValueOnce({ ok: true, email: 'new@aviv.co' });
    show('t.sig');
    await userEvent.click(await screen.findByTestId('verify-email-retry'));
    expect(await screen.findByTestId('verify-email-done')).toBeInTheDocument();
    expect(verifyEmailChange).toHaveBeenCalledTimes(2);
  });
});

describe('★★ Google sign-in and the address change (2026-11-22)', () => {
  it('★★ done, with the Google connection gone: says so, in the approved words', async () => {
    verifyEmailChange.mockResolvedValue({
      ok: true,
      email: 'new@aviv.co',
      googleDisconnected: true,
    });
    show('t.sig');
    expect(await screen.findByTestId('verify-email-google-disconnected')).toHaveTextContent(
      security.verifyEmail.googleDisconnected,
    );
  });

  it('★ done, Google untouched: no such line', async () => {
    verifyEmailChange.mockResolvedValue({
      ok: true,
      email: 'new@aviv.co',
      googleDisconnected: false,
    });
    show('t.sig');
    await screen.findByTestId('verify-email-done');
    expect(screen.queryByTestId('verify-email-google-disconnected')).toBeNull();
  });

  it('⚠⚠ Google the only way in: its reason, and no retry - a password comes first', async () => {
    verifyEmailChange.mockResolvedValue({ ok: false, reason: 'no_other_sign_in' });
    show('t.sig');
    const refused = await screen.findByTestId('verify-email-refused');
    expect(refused).toHaveTextContent(security.verifyEmail.reason.no_other_sign_in);
    expect(screen.queryByRole('button', { name: security.verifyEmail.retry })).toBeNull();
  });

  it('★ did not complete, Google already gone: its reason, and a retry', async () => {
    verifyEmailChange.mockResolvedValue({ ok: false, reason: 'unfinished_google' });
    show('t.sig');
    const refused = await screen.findByTestId('verify-email-refused');
    expect(refused).toHaveTextContent(security.verifyEmail.reason.unfinished_google);
    expect(screen.getByRole('button', { name: security.verifyEmail.retry })).toBeInTheDocument();
  });
});
