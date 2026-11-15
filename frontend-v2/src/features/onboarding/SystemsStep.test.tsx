import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { integrationSchema, type Integration } from '@/api/contracts/integrations';
import { integrationSuggestionsSchema } from '@/api/contracts/onboarding-v2';
import capabilitiesEn from '@/i18n/messages/en/capabilities.json';
import onboardingEn from '@/i18n/messages/en/onboarding.json';
import onboardingHe from '@/i18n/messages/he/onboarding.json';

/** Step 2. Mocked: nothing connects; the launcher is a marker. */
vi.mock('./SystemsConnect', () => ({
  SystemsConnect: ({
    integration,
    reconnect,
    name,
    store,
    variant,
  }: {
    integration: { slug: string };
    reconnect?: boolean;
    name: string;
    store: string | null;
    variant: string;
  }) => (
    <span
      data-testid={`launcher-${integration.slug}`}
      data-name={name}
      data-store={store ?? ''}
      data-variant={variant}
    >
      {reconnect ? 'reconnect' : 'connect'}
    </span>
  ),
}));
/* Studio's own Shopify way-back components, as markers: their behaviour is shopify.test's. */
vi.mock('@/features/capabilities/ShopifyConnect', () => ({
  ShopifyBillingVerify: ({
    shop,
    needsReconnect,
  }: {
    shop: string | null;
    needsReconnect: boolean;
  }) => (
    <span
      data-testid="billing-verify"
      data-shop={shop ?? ''}
      data-reconnect={String(needsReconnect)}
    />
  ),
  // One banner for all three reads (a store, gone, unread): it keeps a claim that worked.
  ShopifyPending: ({ pending, replace }: { pending: string | null; replace: boolean }) => (
    <span
      data-testid="shopify-pending"
      data-pending={pending ?? 'unread'}
      data-replace={String(replace)}
    />
  ),
}));
vi.mock('@/features/capabilities/IntegrationLogo', () => ({ IntegrationLogo: () => null }));
vi.mock('@/features/capabilities/WooFirewallHelp', () => ({
  WooFirewallHelp: () => <div data-testid="woo-firewall-help" />,
}));
vi.mock('./step-actions', () => ({ saveStep: vi.fn(async () => true) }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { systemsReturn } from './systems-return';
import { afterSystems, standingOf, SystemsStep } from './SystemsStep';

const integration = (slug: string, connection: object | null = null): Integration =>
  integrationSchema.parse({
    id: `i-${slug}`,
    slug,
    name: slug === 'shopify' ? 'Shopify' : 'ReturnGO',
    // Shopify installs from Shopify; ReturnGO is a key form, as in the catalogue.
    authType: slug === 'shopify' ? 'OAUTH2' : 'API_KEY',
    authSchema:
      slug === 'shopify'
        ? { oauth: true, fields: [] }
        : {
            oauth: false,
            fields: [{ key: 'apiKey', type: 'password', label: 'API key', required: true }],
          },
    tenantConnection: connection ? { id: `c-${slug}`, ...connection } : null,
  });
const suggestions = integrationSuggestionsSchema.parse([
  { slug: 'shopify', name: 'Shopify', reason: 'platform', connected: false },
  {
    slug: 'returngo',
    name: 'ReturnGO',
    reason: 'detected_on_site',
    evidenceUrl: 'https://avivco.il/pages/returns',
    connected: false,
  },
]);
const show = (props: Partial<Parameters<typeof SystemsStep>[0]> = {}, he = false) =>
  render(
    <NextIntlClientProvider
      locale={he ? 'he' : 'en'}
      messages={{ onboarding: he ? onboardingHe : onboardingEn, capabilities: capabilitiesEn }}
    >
      <SystemsStep
        suggestions={suggestions}
        integrations={[integration('shopify'), integration('returngo')]}
        shopify={{ mode: 'listing', helpUrl: null }}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('★★ step 2: only what the site suggests, each with why and one way to connect', () => {
  it('★★ the platform and the tool, in the route’s order, each with its reason', () => {
    show();
    expect(screen.getByTestId('systems-why-shopify')).toHaveTextContent(
      'Your site runs on Shopify.',
    );
    expect(screen.getByTestId('systems-why-returngo')).toHaveTextContent(
      'We saw ReturnGO on your site.',
    );
    expect(screen.getByTestId('launcher-shopify')).toHaveTextContent('connect');
    expect(screen.getByTestId('launcher-returngo')).toHaveTextContent('connect');
  });

  it('★★ where a tool was seen is a link to that page, never the address written out', () => {
    show();
    const where = screen.getByTestId('systems-where-returngo');
    expect(where).toHaveAttribute('href', 'https://avivco.il/pages/returns');
    expect(where).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('systems')).not.toHaveTextContent('https://');
    expect(screen.queryByTestId('systems-where-shopify')).toBeNull();
  });

  it('★ an unknown reason: no why line, never a guessed one', () => {
    show({
      suggestions: integrationSuggestionsSchema.parse([
        { slug: 'shopify', name: 'Shopify', reason: 'vibes' },
      ]),
    });
    expect(screen.queryByTestId('systems-why-shopify')).toBeNull();
  });

  it('★★ connected: said, no launcher; ERROR is NOT connected - it reconnects', () => {
    show({
      integrations: [
        integration('shopify', { status: 'CONNECTED' }),
        integration('returngo', { status: 'ERROR', lastError: 'boom' }),
      ],
    });
    expect(screen.getByTestId('systems-connected-shopify')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('launcher-shopify')).toBeNull();
    expect(screen.getByTestId('systems-failing-returngo')).toHaveTextContent('Needs reconnecting');
    expect(screen.getByTestId('launcher-returngo')).toHaveTextContent('reconnect');
  });

  it('★ the catalogue’s row beats the suggestion’s flag (a stale "connected")', () => {
    show({
      suggestions: integrationSuggestionsSchema.parse([
        { slug: 'shopify', name: 'Shopify', reason: 'platform', connected: true },
      ]),
      integrations: [integration('shopify', { status: 'ERROR', lastError: 'x' })],
    });
    expect(screen.queryByTestId('systems-connected-shopify')).toBeNull();
    expect(screen.getByTestId('systems-failing-shopify')).toBeInTheDocument();
  });

  it('a suggestion GOTCHA does not offer: said, no launcher', () => {
    show({ integrations: [integration('shopify')] });
    expect(screen.getByTestId('systems-not-offered-returngo')).toHaveTextContent(
      "Connecting ReturnGO isn't available yet.",
    );
  });

  it('★★ the platform leads, big; the tool seen on the site is a quiet row under it', () => {
    show();
    expect(screen.getByTestId('launcher-shopify')).toHaveAttribute('data-variant', 'hero');
    expect(screen.getByTestId('launcher-shopify')).toHaveAttribute('data-name', 'Shopify');
    expect(screen.getByTestId('launcher-returngo')).toHaveAttribute('data-variant', 'row');
    expect(screen.getByTestId('systems-shopify')).toHaveTextContent('Found on your site');
    expect(screen.getByText('Also on your site')).toBeInTheDocument();
  });

  it('★★ the card says what connecting gives and what happens: your store admin, approve, back here', () => {
    show();
    expect(screen.getByTestId('systems-gives')).toHaveTextContent(
      'GOTCHA checks the store before every answer about an order',
    );
    const how = screen.getByTestId('systems-how');
    expect(how).toHaveTextContent("You go to your store's admin");
    expect(how).toHaveTextContent('You approve access for GOTCHA');
    expect(how).toHaveTextContent('You come back here, and the store is connected');
  });

  it('★★ a system that can’t connect from HERE is not shown; one quiet line says more connect later', () => {
    const elsewhere = integrationSchema.parse({
      id: 'i-k',
      slug: 'klaviyo',
      name: 'Klaviyo',
      authType: 'OAUTH2',
      authSchema: { oauth: true, fields: [] },
    });
    show({
      suggestions: integrationSuggestionsSchema.parse([
        { slug: 'shopify', name: 'Shopify', reason: 'platform' },
        { slug: 'klaviyo', name: 'Klaviyo', reason: 'detected_on_site' },
      ]),
      integrations: [integration('shopify'), elsewhere],
    });
    expect(screen.getByTestId('systems-shopify')).toBeInTheDocument();
    expect(screen.queryByTestId('systems-klaviyo')).toBeNull();
    expect(screen.getByTestId('systems-more-later')).toHaveTextContent(
      'More systems can be connected later, in Settings.',
    );
    expect(screen.getByTestId('systems')).not.toHaveTextContent('previous app');
  });

  it('★ only such systems: no empty card, the quiet line, and a primary Continue', () => {
    const elsewhere = integrationSchema.parse({
      id: 'i-k',
      slug: 'klaviyo',
      name: 'Klaviyo',
      authType: 'OAUTH2',
      authSchema: { oauth: true, fields: [] },
    });
    show({
      suggestions: integrationSuggestionsSchema.parse([
        { slug: 'klaviyo', name: 'Klaviyo', reason: 'detected_on_site' },
      ]),
      integrations: [elsewhere],
    });
    expect(screen.queryByTestId('systems-empty')).toBeNull();
    expect(screen.getByTestId('systems-more-later')).toBeInTheDocument();
    expect(screen.getByTestId('systems-next')).toHaveTextContent(/^Continue$/);
    expect(screen.getByTestId('systems-next').className).toMatch(/primary/);
  });

  it('★★ the way on: "Continue without connecting" is the QUIET button, with what that costs; Continue is primary once one is connected', () => {
    const { unmount } = show();
    expect(screen.getByTestId('systems-next')).toHaveTextContent('Continue without connecting');
    expect(screen.getByTestId('systems-next').className).toMatch(/skip/);
    expect(screen.getByTestId('systems-next').className).not.toMatch(/primary/);
    expect(screen.getByTestId('systems-next')).toHaveAttribute('href', afterSystems(false));
    expect(screen.getByTestId('systems-skip-why')).toHaveTextContent("can't check an order");
    unmount();
    show({
      integrations: [integration('shopify', { status: 'CONNECTED' }), integration('returngo')],
    });
    expect(screen.getByTestId('systems-next')).toHaveTextContent(/^Continue$/);
    expect(screen.getByTestId('systems-next').className).toMatch(/primary/);
    expect(screen.queryByTestId('systems-skip-why')).toBeNull();
  });

  it('★ nothing to suggest: said, and Continue (nothing to skip)', () => {
    show({ suggestions: [] });
    expect(screen.getByTestId('systems-empty')).toHaveTextContent(
      "We didn't find a system on your site",
    );
    expect(screen.getByTestId('systems-next')).toHaveTextContent(/^Continue$/);
    expect(screen.queryByTestId('systems-skip-why')).toBeNull();
  });

  it('★★ suggestions unread: said, never "nothing to suggest"', () => {
    show({ suggestions: null });
    expect(screen.getByTestId('systems-unread')).toBeInTheDocument();
    expect(screen.queryByTestId('systems-empty')).toBeNull();
  });

  it('Hebrew: the why isolates the Latin name', () => {
    show({}, true);
    const why = screen.getByTestId('systems-why-shopify');
    expect(why).toHaveTextContent('האתר שלכם בנוי על Shopify.');
    expect(why.querySelector('bdi')).toHaveTextContent('Shopify');
  });

  it('standingOf: no row none; CONNECTED connected; ERROR failing; PENDING none', () => {
    expect(standingOf(null)).toBe('none');
    expect(standingOf(integration('shopify', { status: 'CONNECTED' }))).toBe('connected');
    expect(standingOf(integration('shopify', { status: 'ERROR', lastError: 'x' }))).toBe('failing');
    expect(standingOf(integration('shopify', { status: 'PENDING' }))).toBe('none');
  });
});

describe('★★ the way back to step 2 (flow=onboarding_systems): each return query, said, then tidied', () => {
  const woo = (connection: object | null = null) =>
    integrationSchema.parse({
      id: 'i-woo',
      slug: 'woocommerce',
      name: 'WooCommerce',
      authType: 'OAUTH2',
      authSchema: { oauth: false, fields: [] },
      tenantConnection: connection ? { id: 'c-woo', ...connection } : null,
    });
  const wooSuggestions = integrationSuggestionsSchema.parse([
    { slug: 'woocommerce', name: 'WooCommerce', reason: 'platform', connected: false },
  ]);
  const back = (
    query: string,
    props: Partial<Parameters<typeof SystemsStep>[0]> = {},
    he = false,
  ) => {
    window.history.replaceState(null, '', `/onboarding/systems?${query}`);
    return show(
      {
        suggestions: wooSuggestions,
        integrations: [woo(), integration('shopify')],
        returned: systemsReturn(Object.fromEntries(new URLSearchParams(query))),
        ...props,
      },
      he,
    );
  };

  it("★★ a firewall answered, not the store: the help, in WooCommerce's card, under the sentence (2026-11-15)", () => {
    back('system=woocommerce&error=store_firewall_challenge');
    const landing = screen.getByTestId('systems-landing-woocommerce');
    expect(landing).toHaveTextContent(
      onboardingEn.systems.return.error.store_firewall_challenge.replace('{name}', 'WooCommerce'),
    );
    expect(screen.getByTestId('systems-woocommerce')).toContainElement(
      screen.getByTestId('woo-firewall-help'),
    );
  });

  it('★ any other failure draws no firewall help', () => {
    back('system=woocommerce&error=denied');
    expect(screen.queryByTestId('woo-firewall-help')).toBeNull();
  });

  it('★★ connected=1: said in the card, the card is connected, Continue is primary, the query is gone', () => {
    back('system=woocommerce&connected=1&preview=1', {
      integrations: [woo({ status: 'CONNECTED' })],
    });
    const landing = screen.getByTestId('systems-landing-woocommerce');
    expect(landing).toHaveAttribute('role', 'status');
    expect(landing).toHaveTextContent('WooCommerce is connected.');
    expect(screen.getByTestId('systems-woocommerce')).toContainElement(landing);
    expect(screen.getByTestId('systems-connected-woocommerce')).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-woocommerce')).toBeNull();
    expect(screen.getByTestId('systems-next')).toHaveTextContent(/^Continue$/);
    // Only the way back is taken out of the address; preview stays.
    expect(window.location.search).toBe('?preview=1');
  });

  it('★★ error=<code>: what happened and what to do next, beside the button that does it', () => {
    back('system=woocommerce&error=denied');
    const landing = screen.getByTestId('systems-landing-woocommerce');
    expect(landing).toHaveAttribute('role', 'alert');
    expect(landing).toHaveTextContent('Connecting WooCommerce was cancelled, so nothing changed.');
    expect(landing).toHaveTextContent('Connect again');
    expect(screen.getByTestId('launcher-woocommerce')).toHaveTextContent('connect');
    expect(window.location.search).toBe('');
  });

  it('★ a code we do not name is said generically, never printed', () => {
    back('system=woocommerce&error=<script>');
    expect(screen.getByTestId('systems-landing-woocommerce')).toHaveTextContent(
      "WooCommerce didn't connect. Try connecting again, or continue without it.",
    );
    expect(screen.getByTestId('systems')).not.toHaveTextContent('<script>');
  });

  it('★ a system the step does not show: the sentence goes above, by its catalogue name', () => {
    const hubspot = integrationSchema.parse({
      id: 'i-h',
      slug: 'hubspot',
      name: 'HubSpot',
      authType: 'OAUTH2',
      authSchema: { oauth: true, fields: [] },
    });
    back('system=hubspot&error=insufficient_permissions', {
      integrations: [woo(), hubspot],
    });
    expect(screen.getByTestId('systems-landing-hubspot')).toHaveTextContent(
      'HubSpot was approved without the access GOTCHA needs. Connect again and approve read and write access.',
    );
    expect(screen.getByTestId('systems-woocommerce')).not.toContainElement(
      screen.getByTestId('systems-landing-hubspot'),
    );
  });

  it('★★ system=shopify&error=shop_connected_elsewhere: the store is elsewhere, and the two ways on', () => {
    back('system=shopify&error=shop_connected_elsewhere', {
      suggestions: integrationSuggestionsSchema.parse([
        { slug: 'shopify', name: 'Shopify', reason: 'platform' },
      ]),
    });
    expect(screen.getByTestId('systems-landing-shopify')).toHaveTextContent(
      'That store is already connected to another GOTCHA workspace. Disconnect it there first, or connect a different store.',
    );
  });

  it('★★ system=shopify&pending=1&reason=replace_store: Studio’s claim, as a replace', () => {
    back('system=shopify&pending=1&reason=replace_store', {
      shopifyPending: 'avivco.myshopify.com',
    });
    const pending = screen.getByTestId('shopify-pending');
    expect(pending).toHaveAttribute('data-pending', 'avivco.myshopify.com');
    expect(pending).toHaveAttribute('data-replace', 'true');
    expect(screen.queryByTestId('systems-landing-shopify')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('★ pending with nothing to claim: said, never silence', () => {
    back('system=shopify&pending=1', { shopifyPending: 'gone' });
    // The banner draws "gone" itself (ShopifyConnect's own tests); here, the read reaches it.
    expect(screen.getByTestId('shopify-pending')).toHaveAttribute('data-pending', 'gone');
  });

  it('★★ system=shopify&billing=verify&shop=: the server is asked (POST /api/billing/shopify/complete), the shop passed on', () => {
    back('system=shopify&billing=verify&shop=avivco.myshopify.com', {
      integrations: [woo(), integration('shopify', { status: 'CONNECTED' })],
    });
    const verify = screen.getByTestId('billing-verify');
    expect(verify).toHaveAttribute('data-shop', 'avivco.myshopify.com');
    expect(verify).toHaveAttribute('data-reconnect', 'true');
    expect(window.location.search).toBe('');
  });

  it('★ the store the scan read is WooCommerce’s address, only when the site runs on WooCommerce', () => {
    back('', { site: 'https://www.avivco.il' });
    expect(screen.getByTestId('launcher-woocommerce')).toHaveAttribute(
      'data-store',
      'https://www.avivco.il',
    );
  });

  it('Hebrew: the error and its next action, the prefix joined', () => {
    back('system=woocommerce&error=denied', {}, true);
    expect(screen.getByTestId('systems-landing-woocommerce')).toHaveTextContent(
      'החיבור ל‑WooCommerce בוטל, ושום דבר לא השתנה.',
    );
  });
});

describe('systemsReturn: the query, read the way Studio reads it', () => {
  it.each([
    [
      { system: 'woocommerce', connected: '1' },
      { kind: 'connected', slug: 'woocommerce' },
    ],
    [
      { system: 'hubspot', error: 'denied' },
      { kind: 'error', slug: 'hubspot', code: 'denied' },
    ],
    [
      { system: 'hubspot', error: 'whatever' },
      { kind: 'error', slug: 'hubspot', code: 'other' },
    ],
    [
      { system: 'shopify', error: 'shop_connected_elsewhere' },
      { kind: 'error', slug: 'shopify', code: 'shop_connected_elsewhere' },
    ],
    [
      { system: 'shopify', pending: '1', reason: 'replace_store' },
      { kind: 'pending', slug: 'shopify', replace: true },
    ],
    [
      { system: 'shopify', pending: '1' },
      { kind: 'pending', slug: 'shopify', replace: false },
    ],
    [
      { system: 'shopify', billing: 'verify', shop: 'a.myshopify.com' },
      { kind: 'billing', slug: 'shopify', shop: 'a.myshopify.com' },
    ],
    [
      { system: 'shopify', billing: 'verify' },
      { kind: 'billing', slug: 'shopify', shop: null },
    ],
    // Pending and billing are Shopify's alone.
    [{ system: 'hubspot', pending: '1' }, null],
    [{ system: '../x', connected: '1' }, null],
    [{ connected: '1' }, null],
    [{ system: 'hubspot' }, null],
    [{}, null],
  ])('%j → %j', (query, expected) => {
    expect(systemsReturn(query)).toEqual(expected);
  });
});
