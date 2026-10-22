import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import auth from '@/i18n/messages/en/auth.json';
import type { SetupLinkReason } from '@/features/setup-link/reasons';

// ⚠ Nothing here mails anyone: every answer is the test's own.
const resendSetupLink = vi.hoisted(() => vi.fn());
vi.mock('@/features/setup-link/actions', () => ({ resendSetupLink }));

const { SetupLinkPanel } = await import('./SetupLinkPanel');

const show = (reason: SetupLinkReason, token: string | null = 'dead-1') =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth }}>
      <SetupLinkPanel reason={reason} token={token} signInHref="/he/sign-in" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  resendSetupLink.mockReset();
});

describe('★★ /setup-link/expired - what happened, and the repair beside it', () => {
  it.each([
    ['expired', 'That link has expired', true],
    ['revoked', 'That link was replaced', true],
    ['idp_unavailable', 'Our sign-in service did not answer', true],
    ['invalid', 'That link is not valid', false],
    ['identity_missing', 'We could not find your account', false],
  ] as const)(
    '%s: says so; a new link is offered only where one repairs it',
    (reason, title, offered) => {
      show(reason);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
      expect(screen.queryByTestId('setup-link-resend') !== null).toBe(offered);
    },
  );

  it('⚠ no token, no button - there is nothing to send', () => {
    show('expired', null);
    expect(screen.queryByTestId('setup-link-resend')).toBeNull();
  });

  it('★★ sends the dead token, and then only "check your inbox"', async () => {
    resendSetupLink.mockResolvedValue({ ok: true });
    show('expired');
    await userEvent.click(screen.getByTestId('setup-link-resend'));
    expect(await screen.findByTestId('setup-link-sent')).toHaveTextContent('Check your inbox');
    expect(resendSetupLink).toHaveBeenCalledWith('dead-1');
  });

  it.each([
    ['rate_limited', 'several new links in a short time'],
    ['failed', 'Could not send a new link'],
  ])('a refusal (%s) is said, and the button is offered again', async (reason, words) => {
    resendSetupLink.mockResolvedValue({ ok: false, reason });
    show('revoked');
    await userEvent.click(screen.getByTestId('setup-link-resend'));
    expect(await screen.findByTestId('setup-link-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('setup-link-resend')).toBeEnabled();
  });

  it('⚠ one press, one request - each send revokes the last link', async () => {
    let answer: (value: unknown) => void = () => {};
    resendSetupLink.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show('expired');
    const button = screen.getByTestId('setup-link-resend');
    button.click();
    button.click();
    answer({ ok: true });
    await screen.findByTestId('setup-link-sent');
    expect(resendSetupLink).toHaveBeenCalledTimes(1);
  });

  it('the way to sign in is there for somebody who already set a password', () => {
    show('expired');
    expect(screen.getByTestId('setup-link-sign-in')).toHaveAttribute('href', '/he/sign-in');
  });
});
