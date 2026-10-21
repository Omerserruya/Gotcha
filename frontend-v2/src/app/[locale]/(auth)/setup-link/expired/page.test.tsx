import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/auth.json';

/* The page reads the URL; the panel is tested on its own. */
vi.mock('./SetupLinkPanel', () => ({
  SetupLinkPanel: (props: { reason: string; token: string | null; signInHref: string }) => (
    <div
      data-testid="panel"
      data-reason={props.reason}
      data-token={props.token ?? 'none'}
      data-sign-in={props.signInHref}
    />
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

const { default: Page } = await import('./page');

const panelFor = async (search: { reason?: string | string[]; t?: string | string[] }) => {
  const { unmount } = render(
    <NextIntlClientProvider locale="en" messages={{ auth: messages }}>
      {await Page({
        params: Promise.resolve({ locale: 'he' }),
        searchParams: Promise.resolve(search),
      })}
    </NextIntlClientProvider>,
  );
  const panel = screen.getByTestId('panel');
  const read = {
    reason: panel.getAttribute('data-reason'),
    token: panel.getAttribute('data-token'),
    signIn: panel.getAttribute('data-sign-in'),
  };
  unmount();
  return read;
};

describe('/setup-link/expired - the reason and the dead token, from the URL', () => {
  it('reads ?reason= and ?t=, and signs in in the URL’s language', async () => {
    expect(await panelFor({ reason: 'revoked', t: 'dead-1' })).toEqual({
      reason: 'revoked',
      token: 'dead-1',
      signIn: '/he/sign-in',
    });
  });

  it('no token, an empty or a repeated one: none', async () => {
    expect((await panelFor({ reason: 'expired' })).token).toBe('none');
    expect((await panelFor({ t: '' })).token).toBe('none');
    expect((await panelFor({ t: ['a', 'b'] })).token).toBe('none');
  });

  it('an unknown reason reads as expired', async () => {
    expect((await panelFor({ reason: 'gibberish', t: 'x' })).reason).toBe('expired');
  });
});
