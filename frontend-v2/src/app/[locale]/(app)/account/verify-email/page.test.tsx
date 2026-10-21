import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/* The page passes the token on - one string, or nothing. */
vi.mock('@/features/account/VerifyEmail', () => ({
  VerifyEmail: ({ token }: { token: string | null }) => (
    <div data-testid="verify" data-token={token ?? 'none'} />
  ),
}));
vi.mock('@/shell/PageContainer', () => ({
  PageContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: Page } = await import('./page');

const tokenFor = async (token?: string | string[]) => {
  const { unmount } = render(
    await Page({ searchParams: Promise.resolve(token === undefined ? {} : { token }) }),
  );
  const value = screen.getByTestId('verify').getAttribute('data-token');
  unmount();
  return value;
};

describe('/account/verify-email - the token, as the link carried it', () => {
  it('one token is passed on; none, empty or repeated is none', async () => {
    expect(await tokenFor('t.sig')).toBe('t.sig');
    expect(await tokenFor()).toBe('none');
    expect(await tokenFor('')).toBe('none');
    expect(await tokenFor(['a', 'b'])).toBe('none');
  });
});

describe('/account/verify-email - its loading frame is the working state', () => {
  it('says it is confirming, busy', async () => {
    const { NextIntlClientProvider } = await import('next-intl');
    const security = (await import('@/i18n/messages/en/security.json')).default;
    const { default: Loading } = await import('./loading');
    render(
      <NextIntlClientProvider locale="en" messages={{ security }}>
        <Loading />
      </NextIntlClientProvider>,
    );
    const frame = screen.getByTestId('verify-email-loading');
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(frame).toHaveTextContent('Confirming your new email…');
  });
});
