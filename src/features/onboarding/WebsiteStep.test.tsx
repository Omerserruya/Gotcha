import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverySchema, siteFromEmail, siteHost } from '@/api/contracts/onboarding';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const actions = vi.hoisted(() => ({ startReading: vi.fn() }));
vi.mock('./onboarding-actions', () => actions);

import { WebsiteStep } from './WebsiteStep';

const show = (props: Partial<Parameters<typeof WebsiteStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ onboarding: onboardingMessages }}>
      <WebsiteStep
        guess={{ host: 'avivco.il', from: 'email' }}
        email="maya@avivco.il"
        business="Aviv & Co."
        discovery={null}
        {...props}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  push.mockReset();
  actions.startReading.mockReset();
});

describe('★ the guess', () => {
  it('a work address implies its site; a free mail domain implies none', () => {
    expect(siteFromEmail('maya@avivco.il')).toBe('avivco.il');
    expect(siteFromEmail('maya@gmail.com')).toBeNull();
    expect(siteFromEmail('maya@Outlook.com')).toBeNull();
    expect(siteFromEmail(null)).toBeNull();
  });

  it('an address is a host; anything else is not sent', () => {
    expect(siteHost('https://www.avivco.il/shop?x=1')).toBe('avivco.il');
    expect(siteHost('avivco.il')).toBe('avivco.il');
    expect(siteHost('not a site')).toBeNull();
    expect(siteHost('localhost')).toBeNull();
  });
});

describe('★★ 00d - confirm, not type; nothing is read until yes', () => {
  it('says where the guess came from, and draws no finding before a scan', () => {
    show();
    expect(screen.getByTestId('website-from')).toHaveTextContent('We took it from maya@avivco.il');
    expect(screen.getByTestId('website-card')).toHaveTextContent('avivco.il');
    expect(screen.queryByTestId('website-found')).toBeNull();
    expect(actions.startReading).not.toHaveBeenCalled();
  });

  it('a scan of THIS site shows what it found; one of another site does not', () => {
    const found = discoverySchema.parse({
      websiteDomain: 'https://avivco.il',
      status: 'COMPLETE',
      technology: { platform: { slug: 'shopify', name: 'Shopify' } },
      brand: { languages: ['Hebrew', 'English'] },
    });
    const one = show({ discovery: found });
    expect(screen.getByTestId('website-found')).toHaveTextContent('Shopify');
    expect(screen.getByTestId('website-found')).toHaveTextContent('Hebrew, English');
    one.unmount();
    show({ discovery: { ...found, websiteDomain: 'https://other.co.il' } });
    expect(screen.queryByTestId('website-found')).toBeNull();
  });

  it('Yes, read it: starts the read with consent, then 00e', async () => {
    actions.startReading.mockResolvedValue(true);
    show();
    expect(screen.getByTestId('website-consent')).toHaveTextContent(
      'By continuing you agree to the Terms of Service and the Privacy Policy',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-yes'));
    });
    expect(actions.startReading).toHaveBeenCalledWith('avivco.il', 'en');
    const [to] = push.mock.calls[0] as [{ pathname: string; query: { since: string } }];
    expect(to.pathname).toBe('/onboarding/reading');
    expect(Number.isNaN(Date.parse(to.query.since))).toBe(false);
  });

  it('a different address: one that is not a site is refused here, never sent', async () => {
    show();
    fireEvent.click(screen.getByTestId('website-different'));
    fireEvent.change(screen.getByTestId('website-address'), { target: { value: 'not a site' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-read'));
    });
    expect(screen.getByTestId('website-refused')).toBeInTheDocument();
    expect(actions.startReading).not.toHaveBeenCalled();
  });

  it('nothing to guess from: the question opens at once', () => {
    show({ guess: null, email: 'maya@gmail.com' });
    expect(screen.getByTestId('website-address')).toBeInTheDocument();
    expect(screen.queryByTestId('website-yes')).toBeNull();
  });

  it('no website: the three other starts are drawn, off, with the reason', () => {
    show();
    for (const key of ['instagram', 'catalogue', 'yourself']) {
      expect(screen.getByTestId(`website-source-${key}`)).toBeDisabled();
    }
    expect(screen.getByTestId('website-elsewhere')).toHaveTextContent(
      "Starting from these isn't available yet",
    );
  });
});
