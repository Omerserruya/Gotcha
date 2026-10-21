import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/auth.json';

/*
 * The page's states, from what the read answered. The read and the panel are
 * tested on their own; here each is replaced by what it reports.
 */
const loadInvitation = vi.hoisted(() => vi.fn());
vi.mock('@/features/join/load-invitation', () => ({ loadInvitation }));
vi.mock('./JoinPanel', () => ({
  JoinPanel: ({ token, signInHref }: { token: string; signInHref: string }) => (
    <div data-testid="join-panel" data-token={token} data-sign-in={signInHref} />
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) =>
    createTranslator({
      locale: 'en',
      messages: { auth: messages },
      namespace: namespace as 'auth',
    }),
}));

const { default: JoinPage } = await import('./page');

const show = async (token?: string | string[]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
      {await JoinPage({
        params: Promise.resolve({ locale: 'he' }),
        searchParams: Promise.resolve(token === undefined ? {} : { token }),
      })}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  loadInvitation.mockReset();
});

describe('★★ /join - every state the legacy page had', () => {
  it('valid: the panel, with the token and the way to sign in, in the URL’s language', async () => {
    loadInvitation.mockResolvedValue({
      state: 'valid',
      invitation: { tenant: { name: 'Aviv' }, email: null },
    });
    await show('tok-1');
    expect(loadInvitation).toHaveBeenCalledWith('tok-1');
    const panel = screen.getByTestId('join-panel');
    expect(panel).toHaveAttribute('data-token', 'tok-1');
    expect(panel).toHaveAttribute('data-sign-in', '/he/sign-in');
  });

  it('no token, or two of them: missing - nothing to accept', async () => {
    loadInvitation.mockResolvedValue({ state: 'missing' });
    await show();
    expect(loadInvitation).toHaveBeenCalledWith(undefined);
    expect(screen.getByTestId('join-missing')).toHaveTextContent('This link is incomplete');
    expect(screen.queryByTestId('join-panel')).toBeNull();
    loadInvitation.mockClear();
    await show(['a', 'b']);
    expect(loadInvitation).toHaveBeenCalledWith(undefined);
  });

  it('invalid: says so, and offers sign-in - no retry, the link is dead', async () => {
    loadInvitation.mockResolvedValue({ state: 'invalid' });
    await show('tok-1');
    const state = screen.getByTestId('join-invalid');
    expect(state).toHaveTextContent('This invitation cannot be used');
    expect(screen.queryByTestId('join-retry')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '/he/sign-in',
    );
  });

  it.each([
    ['used', 'This invitation was already used'],
    ['expired', 'This invitation has expired'],
    ['invalid', 'This invitation cannot be used'],
  ] as const)('a dead invitation says why: %s', async (state, title) => {
    loadInvitation.mockResolvedValue({ state });
    await show('tok-1');
    expect(screen.getByTestId(`join-${state}`)).toHaveTextContent(title);
    expect(screen.queryByTestId('join-panel')).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('★★ only a live invitation says the team saved a seat (dev: beside a dead link it read as live)', async () => {
    for (const state of ['invalid', 'used', 'expired', 'missing', 'unreachable'] as const) {
      loadInvitation.mockResolvedValue({ state });
      const { container, unmount } = await show('tok-1');
      expect(container).not.toHaveTextContent('Your team saved you a seat.');
      expect(container).toHaveTextContent('Each invitation works once.');
      unmount();
    }
    loadInvitation.mockResolvedValue({
      state: 'valid',
      invitation: { tenant: { name: 'Aviv' }, email: null },
    });
    const { container } = await show('tok-1');
    expect(container).toHaveTextContent('Your team saved you a seat.');
    expect(container).not.toHaveTextContent('Each invitation works once.');
  });

  it('★ unreachable: not "dead" - and the same link again, to retry', async () => {
    loadInvitation.mockResolvedValue({ state: 'unreachable' });
    await show('a b&c');
    expect(screen.getByTestId('join-unreachable')).toHaveTextContent(
      'We could not read this invitation',
    );
    expect(screen.getByTestId('join-retry')).toHaveAttribute('href', '/he/join?token=a%20b%26c');
  });
});
