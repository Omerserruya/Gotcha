import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { businessCoreSchema } from '@/api/contracts/business-core';
import { capabilitySchema } from '@/api/contracts/capabilities';
import capabilities from '@/i18n/messages/en/capabilities.json';
import messages from '@/i18n/messages/en/business-core.json';

vi.mock('@/i18n/navigation', () => ({
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
}));
vi.mock('@/features/capabilities/PermissionChoice', () => ({
  PermissionChoice: ({ capability }: { capability: { toolName: string } }) => (
    <span data-testid={`choice-${capability.toolName}`} />
  ),
}));
vi.mock('./ElectPart', () => ({ ElectPart: () => <div data-testid="elect" /> }));

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

describe('★ 14 — every row has its ›', () => {
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

describe('★ 14c / 14d — a part’s drawer', () => {
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

  it('what it reads is "—": nothing serves it', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: [] }));
    expect(screen.getByTestId('part-reads')).toHaveTextContent(/^—$/);
  });

  it('a failed actions read is "—", never "no actions"', async () => {
    inIntl(await PartDrawer({ part: store, capabilities: null }));
    expect(screen.getByTestId('part-actions-unread')).toHaveAttribute(
      'title',
      expect.stringMatching(/couldn't read/i),
    );
  });
});

describe('★ 14e — across both', () => {
  it('asks the customer-records system first, then GOTCHA makes a record', async () => {
    inIntl(await AcrossDrawer({ crm: core.roles[1]! }));
    expect(screen.getByTestId('across-order')).toHaveTextContent(/^ShopifyAsked firstGOTCHA/);
  });
});
