import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { integrationSchema, type Integration } from '@/api/contracts/integrations';
import messages from '@/i18n/messages/en/capabilities.json';

import { IntegrationRail } from './IntegrationRail';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'capabilities') =>
    createTranslator({ locale: 'en', messages: { capabilities: messages }, namespace }),
}));

const entry = (over: Record<string, unknown> = {}): Integration =>
  integrationSchema.parse({
    id: 'i-shopify',
    slug: 'shopify',
    name: 'Shopify',
    category: 'Commerce',
    ...over,
  });

/*
 * ★ THE PROVIDER IS NOT DECORATION. The rail's lists moved into
 * `IntegrationFinder`, a client component, because only the filter needs state.
 * A client component inside a server tree with no `NextIntlClientProvider`
 * throws on its first `useTranslations` — the seventh time that has happened in
 * this project, and the reason it is noted here rather than silently added.
 */
const show = async (integrations: readonly Integration[] | null) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ capabilities: messages }}>
      {await IntegrationRail({ integrations })}
    </NextIntlClientProvider>,
  );

describe('★★ the list is whatever the table holds', () => {
  it('★★ counts what is really there, not the design’s 58', async () => {
    /*
     * The design draws "Available · 58" over ten named providers, most of
     * which have no catalogue row. Printing 58 above a list of 17 — or
     * padding the list — would imply coverage the product does not have,
     * which is the same defect as a knowledge counter made of candidates
     * nobody accepted.
     */
    await show([entry({ slug: 'a', name: 'A' }), entry({ slug: 'b', name: 'B' })]);
    expect(screen.getByTestId('rail-available')).toHaveTextContent(/Available · 2/);
    expect(screen.getByTestId('rail-available')).not.toHaveTextContent(/58/);
  });

  it('★★ a BROKEN connection stays connected, with its state', async () => {
    /*
     * `status: "ERROR"` is still a connection. Moving it to "available"
     * would offer a Connect button for something already connected — the
     * distinction 14c, 04d and 05d each had to make on their own.
     */
    await show([entry({ slug: 'shopify', tenantConnection: { id: 'c1', status: 'ERROR' } })]);
    expect(screen.getByTestId('connected-shopify')).toBeInTheDocument();
    expect(screen.queryByTestId('available-shopify')).toBeNull();

    /*
     * ★★ THE STATE'S NAME, AND THIS ASSERTION USED TO REQUIRE THE ENUM.
     *
     * It read `toHaveTextContent('ERROR')` — so the raw code on screen was
     * pinned by a test, and a browser walk found it there. The rule this test
     * means is that a broken connection stays in the connected group AND says
     * what is wrong with it; the code was never the point.
     */
    const state = screen.getByTestId('connected-state-shopify');
    expect(state).toHaveTextContent(/needs attention/i);
    expect(state).not.toHaveTextContent('ERROR');
    /* The durable form: no screaming-snake value anywhere on the rail. */
    expect(document.body.textContent).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
  });

  it('★★ never prints a date beside a connection', async () => {
    /*
     * The route is explicit: `lastTestedAt` is a CONNECTION TEST, and
     * *"there is no sync concept for integrations anywhere in this system…
     * this must never be surfaced or renamed as 'last synced'. It would tell
     * a customer their data is current when all that happened is a
     * credential check passing."* Wrong in the reassuring direction.
     */
    const { container } = await show([
      entry({
        slug: 'shopify',
        tenantConnection: {
          id: 'c1',
          status: 'ACTIVE',
          lastTestedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    ]);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/synced|last sync|up to date/i);
    expect(text).not.toMatch(/2026/);
  });

  it('★ groups the available list by the catalogue’s own category', async () => {
    await show([
      entry({ slug: 'x', name: 'X', category: 'Payments' }),
      entry({ slug: 'y', name: 'Y', category: 'Shipping' }),
    ]);
    expect(screen.getByTestId('rail-available')).toHaveTextContent(/Payments/);
    expect(screen.getByTestId('rail-available')).toHaveTextContent(/Shipping/);
  });

  it('★ an entry with no category keeps its own group rather than being assigned one', async () => {
    // Inventing a category is how a filter starts lying about what it holds.
    await show([entry({ slug: 'z', name: 'Z', category: null })]);
    expect(screen.getByTestId('rail-available')).toHaveTextContent(/Everything else/i);
  });

  it('★ a failed read is not an empty catalogue', async () => {
    await show(null);
    expect(screen.getByTestId('rail-unavailable')).toHaveTextContent(/couldn't read/i);
    expect(screen.queryByTestId('rail-available')).toBeNull();
  });

  it('says plainly when nothing is connected', async () => {
    await show([entry()]);
    expect(screen.getByTestId('rail-none-connected')).toHaveTextContent(/Nothing is connected/i);
  });
});

describe('★★ finding one of seventeen', () => {
  const CATALOGUE = [
    entry({ slug: 'shopify', name: 'Shopify', category: 'ECOMMERCE', description: 'Orders' }),
    entry({
      slug: 'monday',
      name: 'Monday',
      category: 'PROJECT_MANAGEMENT',
      description: 'Boards',
    }),
    entry({
      slug: 'hubspot',
      name: 'HubSpot',
      category: 'CRM',
      description: 'Contacts and deals',
    }),
  ];

  const type = async (text: string) => {
    await userEvent.type(screen.getByTestId('integration-search'), text);
  };

  it('★★ filters by name', async () => {
    await show(CATALOGUE);
    await type('shop');
    expect(screen.getByTestId('available-shopify')).toBeInTheDocument();
    expect(screen.queryByTestId('available-monday')).toBeNull();
  });

  it('★★ filters by what it does and by its category, which the label promises', async () => {
    /*
     * The placeholder names three fields — name, description, category — rather
     * than saying "Search", which promises everything. A label that promises
     * more than the filter matches is how a reader concludes an integration is
     * absent from the catalogue.
     */
    await show(CATALOGUE);
    await type('deals');
    expect(screen.getByTestId('available-hubspot')).toBeInTheDocument();
    expect(screen.queryByTestId('available-shopify')).toBeNull();
  });

  it('★★ does NOT match a tool name, because the row would not explain itself', async () => {
    /*
     * A match on a tool underneath puts an integration in the results for a word
     * that appears nowhere on its row, and the reader cannot tell why it is
     * there. Deliberately narrower than it could be.
     */
    await show([
      entry({
        slug: 'shopify',
        name: 'Shopify',
        catalogTools: [{ id: 't1', slug: 'refund_order', name: 'refund_order' }],
      }),
    ]);
    await type('refund');
    expect(screen.getByTestId('integration-search-none')).toBeInTheDocument();
  });

  it('★★ says nothing matched, and quotes the term back', async () => {
    /*
     * Two empty sections under "Connected · 0" and "Available · 0" is
     * indistinguishable from a tenant with no integrations AND from a failed
     * read. The term is quoted because the commonest cause is a typo the reader
     * cannot see in their own input.
     */
    await show(CATALOGUE);
    await type('zzzz');
    expect(screen.getByTestId('integration-search-none')).toHaveTextContent('zzzz');
  });

  it('★★ the heading says how many of how many while filtering', async () => {
    /*
     * A count that silently changes meaning is how "Available · 1" comes to mean
     * two different things on one screen. Filtered, it says "1 of 3".
     */
    await show(CATALOGUE);
    expect(screen.getByTestId('rail-available')).toHaveTextContent('Available · 3');
    await type('shop');
    expect(screen.getByTestId('rail-available')).toHaveTextContent('Available · 1 of 3');
  });

  it('★★ a category whose every entry is filtered out disappears with them', async () => {
    // An empty category heading claims the category has nothing in it.
    await show(CATALOGUE);
    await type('shop');
    expect(screen.getByText('Ecommerce')).toBeInTheDocument();
    expect(screen.queryByText('Project management')).toBeNull();
  });

  it('★ ignores case and surrounding spaces', async () => {
    await show(CATALOGUE);
    await type('  SHOP  ');
    expect(screen.getByTestId('available-shopify')).toBeInTheDocument();
  });

  it('★★ an empty box shows everything, and says nothing about matching', async () => {
    await show(CATALOGUE);
    await type('shop');
    await userEvent.clear(screen.getByTestId('integration-search'));
    expect(screen.getAllByTestId(/^available-/)).toHaveLength(3);
    expect(screen.queryByTestId('integration-search-none')).toBeNull();
    expect(screen.getByTestId('rail-available')).toHaveTextContent('Available · 3');
  });

  it('★★ offers no filter at all when the catalogue could not be read', async () => {
    /*
     * The failure branch stays on the server, so there is no filter over a list
     * that does not exist — a search box above "we could not read this" invites
     * somebody to conclude their integration is missing.
     */
    await show(null);
    expect(screen.getByTestId('rail-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('integration-search')).toBeNull();
  });
});
