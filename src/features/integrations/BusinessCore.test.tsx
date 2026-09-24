import { render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { businessCoreSchema } from '@/api/contracts/business-core';
import messages from '@/i18n/messages/en/business-core.json';

import { BusinessCore } from './BusinessCore';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'business-core') =>
    createTranslator({ locale: 'en', messages: { 'business-core': messages }, namespace }),
}));

/** The estate as measured. */
const MEASURED = {
  useCase: 'both',
  roles: [
    {
      role: 'ecommerce',
      candidates: [{ slug: 'shopify', name: 'Shopify', connected: false, status: 'ERROR' }],
    },
    {
      role: 'payments',
      candidates: [
        { slug: 'stripe', name: 'Stripe', connected: false, status: null },
        { slug: 'paypal', name: 'PayPal', connected: false, status: null },
      ],
    },
    { role: 'shipping', available: false, reason: 'no_integrations_exist', candidates: [] },
    {
      role: 'crm',
      candidates: [{ slug: 'hubspot', name: 'HubSpot', connected: false, status: null }],
    },
  ],
  catalogueNotes: ['ReturnGO is stored under the ecommerce category but serves returns.'],
};

const render14 = async (over: Record<string, unknown> = {}) =>
  render(await BusinessCore({ core: businessCoreSchema.parse({ ...MEASURED, ...over }) }));

describe('★ "connect one" is the wrong instruction for a broken connection', () => {
  it('tells the merchant to FIX Shopify, not to connect it', async () => {
    /*
     * They already connected it. An empty dropdown, or "nothing connected",
     * sends somebody to the marketplace to redo work they have done.
     */
    await render14();
    const part = screen.getByTestId('core-part-ecommerce');
    expect(part).toHaveAttribute('data-state', 'connected_but_failing');

    const failing = within(part).getByTestId('core-part-failing');
    expect(failing).toHaveTextContent(/Shopify is connected and not working/i);
    expect(failing).toHaveTextContent(/rather than connecting it again/i);
    expect(part).not.toHaveTextContent(/nothing connected/i);
  });

  it('tells them to connect one where nothing was ever started', async () => {
    await render14();
    const part = screen.getByTestId('core-part-payments');
    expect(part).toHaveAttribute('data-state', 'nothing_connected');
    expect(within(part).getByTestId('core-part-nothing')).toHaveTextContent(
      /Stripe, PayPal would work/i,
    );
  });

  it('★ does not let one broken system hide a working one', async () => {
    // Checked after connected, so a healthy candidate wins the state.
    await render14({
      roles: [
        {
          role: 'payments',
          candidates: [
            { slug: 'a', name: 'A', connected: false, status: 'ERROR' },
            { slug: 'b', name: 'B', connected: true, status: 'CONNECTED' },
          ],
        },
      ],
    });
    expect(screen.getByTestId('core-part-payments')).toHaveAttribute(
      'data-state',
      'connected_none_chosen',
    );
  });
});

describe('★ a part nothing can serve is not the merchant’s failing', () => {
  it('says so rather than showing an empty choice', async () => {
    await render14();
    const shipping = screen.getByTestId('core-part-shipping');
    expect(shipping).toHaveAttribute('data-state', 'impossible');
    const note = within(shipping).getByTestId('core-part-impossible');
    expect(note).toHaveTextContent(/no shipping systems to connect/i);
    expect(note).toHaveTextContent(/not something you are missing/i);
  });

  it('never sends them to the marketplace for it', async () => {
    await render14();
    expect(
      within(screen.getByTestId('core-part-shipping')).queryByTestId('core-part-nothing'),
    ).toBeNull();
  });
});

describe('★ the CRM is chosen elsewhere and the screen says where', () => {
  it('explains the one part that cannot be configured here', async () => {
    /*
     * Unexplained, it looks identical to the four that can. And the reason is
     * worth giving: one place for the decision means this screen can never
     * disagree with the system the AI actually calls.
     */
    await render14();
    const crm = within(screen.getByTestId('core-part-crm')).getByTestId('core-part-crm-elsewhere');
    expect(crm).toHaveTextContent(/chosen on the Integrations screen/i);
    expect(crm).toHaveTextContent(/never disagree with the system the AI actually calls/i);
  });

  it('says nothing of the sort for the other parts', async () => {
    await render14();
    expect(
      within(screen.getByTestId('core-part-payments')).queryByTestId('core-part-crm-elsewhere'),
    ).toBeNull();
  });
});

describe('★ built and verified are different words', () => {
  it('says the save has never run against a real connection', async () => {
    /*
     * The election endpoint exists; its success and displacement paths are
     * covered by tests only, because nothing on this deployment is CONNECTED.
     * Offering the control as though it were proven is the implication this
     * sentence removes.
     */
    await render14();
    const note = screen.getByTestId('core-choosing-not-yet');
    expect(note).toHaveTextContent(/never once run against a real connection/i);
    // And names the exception, so "nothing works" is not the takeaway.
    expect(note).toHaveTextContent(/Customer records are the exception/i);
  });
});

describe('the use case decides which parts are asked about', () => {
  it('marks the chosen one and asks when there is none', async () => {
    await render14();
    expect(screen.getByTestId('core-use-case-both')).toHaveAttribute('data-selected', 'true');
    expect(screen.queryByTestId('core-use-case-unset')).toBeNull();

    const unset = await render14({ useCase: null });
    expect(unset.getByTestId('core-use-case-unset')).toHaveTextContent(/choose one/i);
  });

  it('explains why the question is asked at all', async () => {
    await render14();
    expect(screen.getByText(/never asked about shipping or returns/i)).toBeInTheDocument();
  });
});

describe('the platform’s catalogue notes', () => {
  it('renders them verbatim rather than re-deriving them', async () => {
    await render14();
    expect(screen.getByTestId('core-notes')).toHaveTextContent(
      /ReturnGO is stored under the ecommerce category/i,
    );
  });
});

describe('a failed read is not a business with no parts', () => {
  it('says we could not read it', async () => {
    render(await BusinessCore({ core: null }));
    expect(screen.getByTestId('core-unavailable')).toHaveTextContent(/could not read/i);
  });
});
