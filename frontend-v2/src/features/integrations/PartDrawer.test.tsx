import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { businessCoreSchema } from '@/api/contracts/business-core';
import { capabilitySchema } from '@/api/contracts/capabilities';
import { sentenceCase } from '@/api/contracts/integrations';
import capabilities from '@/i18n/messages/en/capabilities.json';
import messages from '@/i18n/messages/en/business-core.json';
import { expectStretchedRow } from '@/test/stretched-row';

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
  Link: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a
      href={
        typeof href === 'string'
          ? href
          : `${href.pathname}${href.query && Object.keys(href.query).length ? `?${new URLSearchParams(href.query)}` : ''}`
      }
      {...rest}
    >
      {children}
    </a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { 'business-core': messages, capabilities },
      namespace: namespace as 'business-core',
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/features/capabilities/PermissionChoice', () => ({
  PermissionChoice: ({
    capability,
    blocked,
  }: {
    capability: { toolName: string };
    blocked?: string;
  }) => (
    <span
      data-testid={`choice-${capability.toolName}`}
      data-blocked={blocked ? 'yes' : undefined}
      title={blocked}
    />
  ),
}));
vi.mock('./ElectPart', () => ({
  ElectPart: () => <div data-testid="elect" />,
  SystemPill: () => <span />,
}));

import { AcrossDrawer } from './AcrossDrawer';
import { BusinessCore } from './BusinessCore';
import { PartDrawer } from './PartDrawer';

const core = businessCoreSchema.parse({
  roles: [
    {
      role: 'ecommerce',
      elected: { slug: 'shopify', name: 'Shopify' },
      source: 'elected',
      candidates: [
        { slug: 'shopify', name: 'Shopify', connected: true, status: 'CONNECTED' },
        { slug: 'woocommerce', name: 'WooCommerce', connected: false, status: null },
      ],
    },
    {
      role: 'crm',
      elected: { slug: 'shopify', name: 'Shopify' },
      source: 'inferred',
      candidates: [],
    },
  ],
});
const store = core.roles[0]!;

const inIntl = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ 'business-core': messages, capabilities }}>
      {node}
    </NextIntlClientProvider>,
  );

describe('★ 14 - every row has its ›', () => {
  it('a part opens ?part=, both across rows open ?panel=across', async () => {
    inIntl(await BusinessCore({ core }));
    expect(screen.getByTestId('core-open-ecommerce')).toHaveAttribute(
      'href',
      '/settings/systems?part=ecommerce',
    );
    expect(screen.getByTestId('core-open-across-identity')).toHaveAttribute(
      'href',
      '/settings/systems?panel=across',
    );
  });
});

describe('★ 14c / 14d - a part’s drawer', () => {
  const cap = (toolName: string, integration: string) =>
    capabilitySchema.parse({ toolName, integration, enabled: true });

  it('who plays it, the choice where the server takes one, and what is not connected', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: [] }));
    expect(screen.getByTestId('part-playing')).toHaveTextContent('ShopifyWorking');
    expect(screen.getByTestId('elect')).toBeInTheDocument();
    expect(screen.getByText('WooCommerce').closest('li')).toHaveTextContent('Connect ↗');
  });

  it('what it may do there is 10’s control, for that system only', async () => {
    inIntl(
      await PartDrawer({
        part: store,
        capabilities: [cap('process_refund', 'shopify'), cap('create_deal', 'hubspot')],
      }),
    );
    expect(screen.getByTestId('choice-process_refund')).toBeInTheDocument();
    expect(screen.queryByTestId('choice-create_deal')).toBeNull();
  });

  it('what it reads is "-": nothing serves it', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: [] }));
    expect(screen.getByTestId('part-reads')).toHaveTextContent(/^-$/);
  });

  it('a failed actions read is "-", never "no actions"', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: null }));
    expect(screen.getByTestId('part-actions-unread')).toHaveAttribute(
      'title',
      expect.stringMatching(/couldn't read/i),
    );
  });
});

describe('★ 14e - across both', () => {
  it('asks the customer-records system first, then GOTCHA makes a record', async () => {
    inIntl(await AcrossDrawer({ crm: core.roles[1]! }));
    expect(screen.getByTestId('across-order')).toHaveTextContent(
      /^1ShopifyAsked first2GOTCHAAnyone else - a new record is made$/,
    );
  });

  it('★ 02’s marks and bar: the CRM’s logo, GOTCHA’s tile; Save drawn with why, Cancel', async () => {
    inIntl(await AcrossDrawer({ crm: core.roles[1]! }));
    expect(screen.getByTestId('across-order').querySelector('[data-logo]')).toHaveAttribute(
      'data-logo',
      'shopify',
    );
    const save = screen.getByTestId('across-save');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save.getAttribute('title')).toMatch(/Nothing here is a setting/);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

describe('★ 14d corrections (measurement of 052d0c2)', () => {
  const shopify = {
    id: 'i1',
    slug: 'shopify',
    name: 'Shopify',
    authType: 'OAUTH2' as const,
    catalogTools: [
      {
        id: 't1',
        slug: 'process_refund',
        name: 'Refund an order',
        riskLevel: null,
        enabled: false,
      },
      { id: 't2', slug: 'cancel_order', name: 'Cancel an order', riskLevel: null, enabled: false },
    ],
    tenantConnection: { id: 'c1', status: 'ERROR' as const, lastTestedAt: '2026-10-01T10:00:00Z' },
  };
  const failingStore = businessCoreSchema.parse({
    roles: [
      {
        role: 'ecommerce',
        candidates: [{ slug: 'shopify', name: 'Shopify', connected: false, status: 'ERROR' }],
      },
    ],
  }).roles[0]!;

  // Backend 3cee674f: every catalogue action of the connection, provisioned or
  // not, with its state and risk - an ERROR connection still lists them.
  const row = (slug: string, over: Record<string, unknown> = {}) =>
    capabilitySchema.parse({
      toolName: `shopify.${slug}`,
      kind: 'integration',
      integration: 'shopify',
      integrationConnected: true,
      integrationStatus: 'CONNECTED',
      state: 'not_provisioned',
      riskLevel: 'HIGH',
      ...over,
    });

  it('a broken system’s actions are its rows, named by the catalogue, with why they cannot be set', async () => {
    inIntl(
      await PartDrawer({
        part: failingStore,
        capabilities: [
          row('process_refund', { integrationConnected: false, integrationStatus: 'ERROR' }),
        ],
        integration: shopify as never,
        storeHost: 'urban-supply-gotcha-demo.myshopify.com',
      }),
    );
    expect(screen.getByTestId('part-actions-blocked')).toHaveTextContent(
      'Hidden while Shopify needs fixing.',
    );
    expect(screen.getByTestId('part-actions')).toHaveTextContent('Refund an order');
    // 10's control, disabled, with the reason as its title - no "-" in its place.
    expect(screen.getByTestId('choice-shopify.process_refund')).toHaveAttribute(
      'data-blocked',
      'yes',
    );
    expect(screen.getByTestId('choice-shopify.process_refund')).toHaveAttribute(
      'title',
      'Hidden while Shopify needs fixing.',
    );
    expect(screen.getByTestId('part-risk-shopify.process_refund')).toHaveTextContent('High risk');
    expect(screen.getByTestId('part-playing-sub')).toHaveTextContent(
      'urban-supply-gotcha-demo.myshopify.com · checked Oct 1',
    );
  });

  it('★ the list is the backend’s: a catalogue action it does not list is not drawn', async () => {
    inIntl(
      await PartDrawer({
        part: store,
        capabilities: [
          row('get_order', { riskLevel: 'LOW', category: 'READ' }),
          row('process_refund', { category: 'WRITE' }),
        ],
        integration: shopify as never,
      }),
    );
    // Not provisioned, on a connected system: settable - the PUT provisions it.
    expect(screen.getByTestId('choice-shopify.process_refund')).toBeInTheDocument();
    expect(screen.getByTestId('choice-shopify.get_order')).toBeInTheDocument();
    expect(screen.getByTestId('part-risk-shopify.get_order')).toHaveTextContent('Low risk');
    // `cancel_order` is in the catalogue and not in the rows.
    expect(screen.getByTestId('part-actions')).not.toHaveTextContent('Cancel an order');
    expect(screen.getByTestId('part-actions').querySelectorAll('li')).toHaveLength(2);
    // The catalogue's category over each group (backend c37f1cf7).
    expect(
      [...screen.getByTestId('part-actions').querySelectorAll('h4')].map((h) => h.textContent),
    ).toEqual(['Changing things', 'Looking things up']);
  });
});

describe('★ 14e corrections - no paragraphs', () => {
  it('the matching rules ride on GOTCHA’s card; the row says "AI summary, in Hebrew"', async () => {
    inIntl(await AcrossDrawer({ crm: core.roles[1]!, language: 'Hebrew' }));
    expect(screen.getByTestId('across-gotcha')).toHaveAttribute(
      'title',
      expect.stringMatching(/exactly one person matches.*two or more match/i),
    );
    expect(screen.getByTestId('across-writeback')).toHaveTextContent(/AI summary, in Hebrew$/);
    expect(screen.getByTestId('across-drawer').querySelectorAll('p')).toHaveLength(0);
  });
});

describe('★ action names in the product’s sentence case', () => {
  it.each([
    ['Cancel Order', 'Cancel order'],
    ['Add Customer To Segment', 'Add customer to segment'],
    ['Add VIP Tag', 'Add VIP tag'],
    ['Change order shipping address', 'Change order shipping address'],
    ['Sync Shopify Orders', 'Sync Shopify orders'],
  ])('%s → %s', (raw, expected) => {
    expect(sentenceCase(raw, 'Shopify')).toBe(expected);
  });
});

describe('★★ a system to connect: its whole row is its Connect (Omer, 2026-10-11)', () => {
  it('WooCommerce, available: one stretched Connect, the row’s only stop', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: [] }));
    const link = screen.getByRole('link', { name: 'Connect ↗' });
    expect(expectStretchedRow(link.closest('li')!)).toBe(link);
  });
});
