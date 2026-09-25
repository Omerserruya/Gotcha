import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
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

const show = async (integrations: readonly Integration[] | null) =>
  render(await IntegrationRail({ integrations }));

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
    expect(screen.getByTestId('connected-state-shopify')).toHaveTextContent('ERROR');
    expect(screen.queryByTestId('available-shopify')).toBeNull();
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
