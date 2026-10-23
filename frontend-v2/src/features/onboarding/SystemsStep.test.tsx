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
vi.mock('@/features/capabilities/ConnectFor', async (original) => ({
  // The real rule for what can connect from here; only the launcher is a marker.
  isLaunchable: (await original<{ isLaunchable: unknown }>()).isLaunchable,
  ConnectFor: ({
    integration,
    reconnect,
    formLabel,
    drawn,
  }: {
    integration: { slug: string };
    reconnect?: boolean;
    formLabel?: string;
    drawn: { connect: string };
  }) => (
    <span
      data-testid={`launcher-${integration.slug}`}
      data-form-label={formLabel}
      data-drawn={drawn.connect}
    >
      {reconnect ? 'reconnect' : 'connect'}
    </span>
  ),
}));
vi.mock('@/features/capabilities/IntegrationLogo', () => ({ IntegrationLogo: () => null }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

  it('★★ connect names the system', () => {
    show();
    const launcher = screen.getByTestId('launcher-returngo');
    expect(launcher).toHaveAttribute('data-form-label', 'Connect ReturnGO');
    expect(launcher).toHaveAttribute('data-drawn', 'Connect ReturnGO');
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
    expect(screen.getByTestId('systems-next').className).toMatch(/secondary/);
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
