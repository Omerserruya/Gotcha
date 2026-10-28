import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectorVerdict, isInstalledKind } from '@/api/contracts/shopify-connector';
import { integrationSchema } from '@/api/contracts/integrations';
import { capabilitySchema } from '@/api/contracts/capabilities';
import enBilling from '@/i18n/messages/en/billing.json';
import heBilling from '@/i18n/messages/he/billing.json';
import enCapabilities from '@/i18n/messages/en/capabilities.json';
import heCapabilities from '@/i18n/messages/he/capabilities.json';
import enCommon from '@/i18n/messages/en/common.json';
import heCommon from '@/i18n/messages/he/common.json';

/*
 * ★★ THE STATE MATRIX (split billing, review 132211).
 *
 * For every Connector state, the Billing page's Connector section and the
 * integration screen's head are rendered from the SAME fixture, in English
 * and in Hebrew, and must say the same thing: the same status, the same
 * "Shopify access" (the server's grantsAccess, verbatim), and a tool line
 * that is "none usable" until the server grants access.
 */

const MESSAGES = {
  en: { billing: enBilling, capabilities: enCapabilities, common: enCommon },
  he: { billing: heBilling, capabilities: heCapabilities, common: heCommon },
} as const;
type Locale = keyof typeof MESSAGES;
const lang = vi.hoisted(() => ({ locale: 'en' as 'en' | 'he' }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: lang.locale,
      messages: MESSAGES[lang.locale] as never,
      namespace: namespace as never,
    }),
  getFormatter: async () => ({ number: (n: number) => String(n) }),
  getLocale: async () => lang.locale,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ''}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/studio/capabilities',
}));
const chooseShopifyPlan = vi.hoisted(() => vi.fn());
vi.mock('./connector-actions', () => ({ chooseShopifyPlan }));
vi.mock('@/features/capabilities/shopify-actions', () => ({
  uninstallShopify: vi.fn(),
  readShopifyConnectorStatus: vi.fn(),
}));

import { SystemHead } from '@/features/capabilities/SystemHead';

import {
  CONNECTOR_FIXTURE_URLS,
  CONNECTOR_FIXTURES,
  type ConnectorFixture,
} from './connector-fixtures';
import { ConnectorSection } from './ConnectorSection';

const SHOPIFY = integrationSchema.parse({
  id: 'i1',
  slug: 'shopify',
  name: 'Shopify',
  tenantConnection: { id: 'c1', status: 'CONNECTED' },
});
const ACTIONS = [
  capabilitySchema.parse({ toolName: 'shopify.cancel_order', integration: 'shopify' }),
  capabilitySchema.parse({ toolName: 'shopify.refund_order', integration: 'shopify' }),
];

/** What each state must READ as - the kind's label, from the catalogue itself. */
const label = (locale: Locale, kind: string) =>
  (MESSAGES[locale].billing.connector.kind as Record<string, string>)[kind]!;

async function renderBoth(locale: Locale, name: ConnectorFixture) {
  lang.locale = locale;
  const verdict = connectorVerdict(CONNECTOR_FIXTURES[name]);
  const billing = render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <div data-testid="billing-screen">{await ConnectorSection({ verdict })}</div>
    </NextIntlClientProvider>,
  );
  const head = render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <div data-testid="integration-screen">
        {await SystemHead({
          integration: SHOPIFY,
          capabilities: ACTIONS,
          usage: null,
          connector: verdict,
        })}
      </div>
    </NextIntlClientProvider>,
  );
  return {
    verdict,
    billing: within(billing.container),
    head: within(head.container),
  };
}

afterEach(() => {
  lang.locale = 'en';
  chooseShopifyPlan.mockReset();
});

const STATES = Object.keys(CONNECTOR_FIXTURES) as ConnectorFixture[];

describe.each(['en', 'he'] as const)('★★ the state matrix, %s', (locale) => {
  const access = MESSAGES[locale].billing.connector.access;
  const sys = MESSAGES[locale].capabilities.system;

  it.each(STATES)('%s: Billing and the integration head give the same verdict', async (name) => {
    const { verdict, billing, head } = await renderBoth(locale, name);
    const fixture = CONNECTOR_FIXTURES[name];

    // The Connector is billed and managed by Shopify - on every state.
    expect(billing.getByTestId('connector-billed-by')).toHaveTextContent(
      MESSAGES[locale].billing.connector.billedBy,
    );

    // Status: the verdict's label, on both screens where both draw it.
    expect(billing.getByTestId('connector-status')).toHaveTextContent(label(locale, verdict.kind));
    if (isInstalledKind(verdict.kind)) {
      expect(head.getByTestId('system-state')).toHaveTextContent(label(locale, verdict.kind));
    }

    // "Shopify access" is the server's grantsAccess, verbatim, and the same on both.
    const word = fixture.grantsAccess ? access.on : access.off;
    expect(billing.getByTestId('connector-access')).toHaveTextContent(word);
    expect(billing.getByTestId('connector-access')).toHaveAttribute(
      'data-access',
      String(fixture.grantsAccess),
    );
    expect(head.getByTestId('system-access')).toHaveAttribute(
      'data-access',
      String(fixture.grantsAccess),
    );
    expect(head.getByTestId('system-access')).toHaveTextContent(word);

    // The tool line: none usable without the grant - never "2 actions".
    const line = head.getByTestId('system-line');
    if (fixture.grantsAccess) {
      expect(line).not.toHaveTextContent(sys.noneUsable);
      expect(line.textContent).toMatch(/2/);
    } else {
      expect(line).toHaveTextContent(sys.noneUsable);
    }
  });

  it.each(STATES)('%s: the Connector section offers no GOTCHA payment', async (name) => {
    const { billing } = await renderBoth(locale, name);
    const section = billing.getByTestId('connector-section');
    // No price, no currency, no card, no GOTCHA checkout.
    expect(section.textContent).not.toMatch(/[$₪€£]|\d+[.,]\d{2}|\bcard\b|כרטיס|checkout|icount/i);
    // Every link is the server's Shopify page or an in-app path - nothing else.
    for (const a of section.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      expect(
        href === CONNECTOR_FIXTURE_URLS.manage ||
          href.startsWith('/studio/capabilities') ||
          href === '/settings/billing/plan',
      ).toBe(true);
    }
  });

  it('active and trialing: "Manage Shopify Connector" is the server\'s manageUrl, exactly', async () => {
    for (const name of ['active', 'trialing', 'both_active', 'past_due'] as const) {
      const { billing } = await renderBoth(locale, name);
      const cta = billing.getByTestId('connector-cta');
      expect(cta).toHaveAttribute('href', CONNECTOR_FIXTURE_URLS.manage);
      expect(cta).toHaveTextContent(MESSAGES[locale].billing.connector.cta.manage);
    }
  });

  it('Core not paid: Connect waits for GOTCHA Core, and says so', async () => {
    const { billing } = await renderBoth(locale, 'core_unpaid');
    expect(billing.queryByTestId('connector-cta')).toBeNull();
    expect(billing.getByTestId('connector-cta-core-first')).toHaveTextContent(
      MESSAGES[locale].billing.connector.coreFirst,
    );
  });

  it('Core only: Connect is an in-app link to the integration screen', async () => {
    const { billing } = await renderBoth(locale, 'core_only');
    expect(billing.getByTestId('connector-cta')).toHaveAttribute(
      'href',
      '/studio/capabilities?system=shopify',
    );
  });

  it('plan selection required: "Authorized", "Shopify Connector required", and never "Active"', async () => {
    const { billing, head } = await renderBoth(locale, 'plan_selection_required');
    expect(head.getByTestId('system-state')).toHaveTextContent(label(locale, 'authorized'));
    expect(head.getByTestId('system-state')).not.toHaveTextContent(label(locale, 'active'));
    expect(billing.getByTestId('connector-detail')).toHaveTextContent(
      locale === 'en' ? 'Shopify Connector required.' : 'נדרש Shopify Connector.',
    );
  });
});

describe('★★ "Choose Shopify plan" opens only the URL the server answered', () => {
  it('the press asks plan-selection and goes where it said - nothing built here', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      chooseShopifyPlan.mockResolvedValue({ ok: true, url: CONNECTOR_FIXTURE_URLS.choose });
      const { billing } = await renderBoth('en', 'plan_selection_required');
      const cta = billing.getByTestId('connector-cta');
      expect(cta.tagName).toBe('BUTTON');
      expect(cta).not.toHaveAttribute('href');
      await userEvent.click(cta);
      expect(chooseShopifyPlan).toHaveBeenCalledOnce();
      expect(assign).toHaveBeenCalledExactlyOnceWith(CONNECTOR_FIXTURE_URLS.choose);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a refusal is said in words, and nothing is opened', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    try {
      chooseShopifyPlan.mockResolvedValue({ ok: false, reason: 'forbidden' });
      const { billing } = await renderBoth('en', 'plan_selection_required');
      await userEvent.click(billing.getByTestId('connector-cta'));
      expect(await screen.findByTestId('connector-cta-refused')).toHaveTextContent(
        'Only someone who manages billing can choose the Shopify Connector plan.',
      );
      expect(assign).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
