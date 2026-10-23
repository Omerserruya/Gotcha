import { within, act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverySchema, siteFromEmail, siteHost } from '@/api/contracts/onboarding';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';
import workspaceMessages from '@/i18n/messages/en/workspace.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const actions = vi.hoisted(() => ({ startScan: vi.fn() }));
vi.mock('./scan-actions', () => actions);

import { WebsiteStep } from './WebsiteStep';

const show = (props: Partial<Parameters<typeof WebsiteStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ onboarding: onboardingMessages, workspace: workspaceMessages }}
    >
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
  actions.startScan.mockReset();
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

describe('★ 00d, measured on dev', () => {
  const read = (over: Record<string, unknown>) =>
    discoverySchema.parse({ websiteDomain: 'https://avivco.il', status: 'COMPLETE', ...over });

  it("the banner is the brand, cut at its tagline - as 13g's mark", () => {
    show({ business: 'Urban Supply - GOTCHA demo' });
    expect(screen.getByTestId('website-wordmark')).toHaveTextContent(/^URBAN SUPPLY$/);
  });

  it('a language code by its name; an industry code by its name, never the key', () => {
    show({
      discovery: read({ brand: { languages: ['he'] }, business: { industry: 'ecommerce' } }),
    });
    expect(screen.getByTestId('website-found')).toHaveTextContent('Hebrew');
    expect(screen.getByTestId('website-found')).not.toHaveTextContent(/\bhe\b/);
    expect(screen.getByTestId('website-kind')).toHaveTextContent('E-commerce');
  });

  it("the read's short description wins over the industry", () => {
    show({
      discovery: read({
        business: { industry: 'ecommerce', summary: 'Home textiles and lighting' },
      }),
    });
    expect(screen.getByTestId('website-kind')).toHaveTextContent('Home textiles and lighting');
  });
});

describe('★★ 00d - confirm, not type; nothing is read until yes', () => {
  it('says where the guess came from, and draws no finding before a scan', () => {
    show();
    expect(screen.getByTestId('website-from')).toHaveTextContent('We took it from maya@avivco.il');
    expect(screen.getByTestId('website-card')).toHaveTextContent('avivco.il');
    expect(screen.queryByTestId('website-found')).toBeNull();
    expect(actions.startScan).not.toHaveBeenCalled();
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
    expect(screen.getByTestId('website-found')).toHaveTextContent('Hebrew and English');
    one.unmount();
    show({ discovery: { ...found, websiteDomain: 'https://other.co.il' } });
    expect(screen.queryByTestId('website-found')).toBeNull();
  });

  it('Yes, read it: starts the read with consent, then 00e', async () => {
    actions.startScan.mockResolvedValue({ ok: true });
    show();
    expect(screen.getByTestId('website-consent')).toHaveTextContent(
      'By continuing you agree to the Terms of Service and the Privacy Policy',
    );
    // The legal pages are the marketing site's: the app no longer serves /legal.
    const consent = screen.getByTestId('website-consent');
    expect(within(consent).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      'https://gotcha.co.il/legal/terms-of-service',
    );
    expect(within(consent).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      'https://gotcha.co.il/legal/privacy-policy',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-yes'));
    });
    expect(actions.startScan).toHaveBeenCalledWith('avivco.il', 'en');
    // The job is the server's: reading reads it, no client clock in the address.
    expect(push).toHaveBeenCalledWith('/onboarding/reading');
  });

  it.each([
    ['invalid', "That doesn't look like a website address."],
    ['failed', "Reading couldn't start. Try again in a moment."],
  ] as const)('★ refused as %s: said, and nowhere else to go', async (reason, text) => {
    actions.startScan.mockResolvedValue({ ok: false, reason });
    show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-yes'));
    });
    expect(screen.getByTestId('website-refused')).toHaveTextContent(text);
    expect(push).not.toHaveBeenCalled();
  });

  it('★ a start that rejects (network, a deploy between) reads as failed', async () => {
    actions.startScan.mockRejectedValue(new Error('Failed to fetch'));
    show();
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-yes'));
    });
    expect(screen.getByTestId('website-refused')).toHaveTextContent("Reading couldn't start.");
  });

  it('a different address: one that is not a site is refused here, never sent', async () => {
    show();
    fireEvent.click(screen.getByTestId('website-different'));
    fireEvent.change(screen.getByTestId('website-address'), { target: { value: 'not a site' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('website-read'));
    });
    expect(screen.getByTestId('website-refused')).toBeInTheDocument();
    expect(actions.startScan).not.toHaveBeenCalled();
  });

  it('nothing to guess from: the question opens at once', () => {
    show({ guess: null, email: 'maya@gmail.com' });
    expect(screen.getByTestId('website-address')).toBeInTheDocument();
    expect(screen.queryByTestId('website-yes')).toBeNull();
  });

  it('no website: the three other starts are statuses - not cards to press - with the reason', () => {
    show();
    for (const key of ['instagram', 'catalogue', 'yourself']) {
      const item = screen.getByTestId(`website-source-${key}`);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('Not available yet');
      expect(item.tagName).not.toBe('BUTTON');
    }
    expect(screen.getByTestId('website-elsewhere')).toHaveTextContent(
      "Starting from these isn't available yet",
    );
  });
});
