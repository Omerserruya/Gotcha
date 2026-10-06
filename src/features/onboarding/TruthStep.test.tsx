import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { integrationSchema, type Integration } from '@/api/contracts/integrations';
import capabilitiesMessages from '@/i18n/messages/en/capabilities.json';
import onboardingMessages from '@/i18n/messages/en/onboarding.json';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/features/capabilities/connect-actions', () => ({
  connectIntegration: vi.fn(),
  startOAuth: vi.fn(),
  startWooOAuth: vi.fn(),
}));
vi.mock('@/features/capabilities/shopify-actions', () => ({
  startShopifyInstall: vi.fn(),
  claimShopifyInstall: vi.fn(),
  verifyShopifyBilling: vi.fn(),
}));

import { standingOf, TruthStep } from './TruthStep';

const system = (
  slug: string,
  name: string,
  connection: Record<string, unknown> | boolean = false,
): Integration =>
  integrationSchema.parse({
    id: `i-${slug}`,
    slug,
    name,
    authType: 'OAUTH2',
    authSchema: { oauth: true, fields: [] },
    tenantConnection:
      connection === false
        ? null
        : {
            id: `c-${slug}`,
            status: 'CONNECTED',
            createdAt: '2026-10-01T00:00:00Z',
            ...(connection === true ? {} : connection),
          },
  });

const show = (props: Partial<Parameters<typeof TruthStep>[0]> = {}) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ onboarding: onboardingMessages, capabilities: capabilitiesMessages }}
    >
      <TruthStep
        integrations={[system('shopify', 'Shopify'), system('woocommerce', 'WooCommerce')]}
        shopify={{ mode: 'listing', helpUrl: null }}
        detected={{ slug: 'shopify', host: 'avivco.il' }}
        system={null}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('★★ 00g - the store the read found, connected the way 10 connects', () => {
  it("the detected platform is first, found on the site, with Shopify's own connect", () => {
    show();
    expect(screen.getByTestId('truth-card')).toHaveTextContent('Shopify');
    expect(screen.getByTestId('truth-found')).toHaveTextContent('Found on avivco.il');
    expect(screen.getByTestId('shopify-start')).toBeInTheDocument();
    expect(screen.getByTestId('truth-connect')).toHaveTextContent('Studio · Integrations');
  });

  it('a tile chosen takes the card; Woo connects by its address', () => {
    show({ system: 'woocommerce' });
    expect(screen.getByTestId('truth-card')).toHaveTextContent('WooCommerce');
    expect(screen.getByTestId('woo-connect')).toBeInTheDocument();
    expect(screen.queryByTestId('truth-found')).toBeNull();
  });

  it('a system the catalogue does not offer says so - no button that does nothing', () => {
    show({ system: 'priority' });
    expect(screen.getByTestId('truth-not-offered')).toHaveTextContent(
      "Connecting Priority isn't available yet",
    );
    expect(screen.queryByTestId('truth-connect')).toBeNull();
  });

  it('unread is not "not offered"', () => {
    show({ integrations: null });
    expect(screen.getByTestId('truth-unread')).toBeInTheDocument();
  });

  it('connected: says so, and Continue - no skip warning', () => {
    show({ integrations: [system('shopify', 'Shopify', true)] });
    expect(screen.getByTestId('truth-connected')).toBeInTheDocument();
    expect(screen.getByTestId('truth-next')).toHaveTextContent('Continue');
    expect(screen.queryByTestId('truth-skip-why')).toBeNull();
  });

  it('nothing connected: skipping is possible, and says what it costs', () => {
    show();
    expect(screen.getByTestId('truth-next')).toHaveTextContent('Skip for now');
    expect(screen.getByTestId('truth-skip-why')).toHaveTextContent("can't check an order");
    expect(screen.getByTestId('truth-next')).toHaveAttribute('href', '/onboarding/try');
  });

  it('what it may change: drawn, every choice off, with the reason', () => {
    show();
    const may = screen.getByTestId('truth-may');
    const choices = may.querySelectorAll('button');
    expect(choices.length).toBe(12);
    choices.forEach((b) => expect(b).toBeDisabled());
    expect(screen.getByTestId('truth-may-why')).toHaveTextContent('once the workspace is live');
  });
});

describe('★★ a connection row is not a connection (dev: Shopify ERROR read "Connected")', () => {
  const ERROR_PAGE = '<!DOCTYPE html><html><body>unauthorized</body></html>';

  it('ERROR, a failed test, or a stored error is "needs reconnecting" - never Connected', () => {
    expect(standingOf(system('shopify', 'Shopify', { status: 'ERROR' }))).toBe('failing');
    expect(standingOf(system('shopify', 'Shopify', { lastTestResult: false }))).toBe('failing');
    expect(standingOf(system('shopify', 'Shopify', { lastError: 'denied' }))).toBe('failing');
    expect(standingOf(system('shopify', 'Shopify', { status: 'PENDING' }))).toBe('none');
    expect(standingOf(system('shopify', 'Shopify', true))).toBe('connected');
    expect(standingOf(null)).toBe('none');
  });

  it('the card: Needs reconnecting, a reason in our words, and Reconnect - not the stored error', () => {
    show({
      integrations: [
        system('shopify', 'Shopify', { status: 'ERROR', lastError: ERROR_PAGE }),
        system('woocommerce', 'WooCommerce', true),
      ],
    });
    expect(screen.queryByTestId('truth-connected')).toBeNull();
    expect(screen.getByTestId('truth-failing')).toHaveTextContent('Needs reconnecting');
    expect(screen.getByTestId('truth-reconnect')).toHaveTextContent(
      'Shopify stopped letting GOTCHA in',
    );
    expect(screen.getByTestId('oauth-shopify')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('<!DOCTYPE');
    expect(screen.getByTestId('truth-tile-woocommerce')).toHaveTextContent('Connected');
  });

  it('a failing store does not count as connected for Continue', () => {
    show({ integrations: [system('shopify', 'Shopify', { status: 'ERROR' })] });
    expect(screen.getByTestId('truth-next')).toHaveTextContent('Skip for now');
  });

  it("tiles use the design's short names", () => {
    show({ integrations: [system('shopify', 'Shopify'), system('custom_api', 'Custom API')] });
    expect(screen.getByTestId('truth-tile-custom_api')).toHaveTextContent('Your API');
  });
});
