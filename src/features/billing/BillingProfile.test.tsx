import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { billingProfileSchema, type PaymentMethod } from '@/api/contracts/billing-profile';
import messages from '@/i18n/messages/en/billing.json';

import { BillingProfileSection } from './BillingProfile';

/**
 * The warning that used to vanish.
 *
 * This block depends on TWO parallel reads and failed roughly one capture in
 * six — a different viewport each run, with a clear request budget. The
 * condition was `methods !== null && ...`, so a lost payment-methods fetch
 * removed the whole warning and left a page that looked complete.
 *
 * A capture cannot cover this: it needs a fetch to fail, and the one time in
 * six that it did, it presented as a flake.
 */

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'billing') =>
    createTranslator({ locale: 'en', messages: { billing: messages }, namespace }),
}));

const NO_PROFILE = billingProfileSchema.parse({ state: 'no_billing_profile' });
const NO_METHODS: readonly PaymentMethod[] = [];

describe('★ a lost read never removes the warning', () => {
  it('says so when the payment methods could not be read', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: null,
        failedInvoiceCount: 4,
      }),
    );
    const said = screen.getByTestId('methods-unknown');
    expect(said).toHaveTextContent(/couldn't check whether you have a payment method/i);
    // And names the consequence, so it is not merely an apology.
    expect(said).toHaveTextContent(/charges will fail/i);
    // The old code rendered NOTHING here.
    expect(screen.queryByTestId('nothing-to-charge')).toBeNull();
  });

  it('★ says so when the invoices could not be counted, instead of rounding to zero', async () => {
    /*
     * There IS no payment method — that much was read. The failure count was
     * not. Defaulting it to 0 demoted "and 4 charges have already failed" to
     * a bare "there's nothing to charge", losing the half that makes it
     * urgent, with nothing to show anything was missing.
     */
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: NO_METHODS,
        failedInvoiceCount: null,
      }),
    );
    const said = screen.getByTestId('nothing-to-charge');
    expect(said).toHaveTextContent(/no payment method on file/i);
    expect(said).toHaveTextContent(/couldn't load your invoices/i);
    // Zero is the reassuring answer and it is one we do not have.
    expect(said).not.toHaveTextContent(/0 charges/i);
  });
});

describe('both facts, stated together, when both were read', () => {
  it('names the count beside the missing card', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: NO_METHODS,
        failedInvoiceCount: 4,
      }),
    );
    const said = screen.getByTestId('nothing-to-charge');
    expect(said).toHaveTextContent(/no payment method on file/i);
    expect(said).toHaveTextContent(/4 charges have already failed/i);
  });

  it('drops the failures clause only when there genuinely are none', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: NO_METHODS,
        failedInvoiceCount: 0,
      }),
    );
    const said = screen.getByTestId('nothing-to-charge');
    expect(said).toHaveTextContent(/nothing for GOTCHA to charge/i);
    expect(said).not.toHaveTextContent(/already failed/i);
  });

  it('says nothing at all when there IS a card', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: [
          {
            id: 'pm1',
            brand: 'Visa',
            last4: '4242',
            isDefault: true,
            expMonth: null,
            expYear: null,
          },
        ],
        failedInvoiceCount: 4,
      }),
    );
    expect(screen.queryByTestId('nothing-to-charge')).toBeNull();
    expect(screen.queryByTestId('methods-unknown')).toBeNull();
    expect(screen.getByTestId('payment-method')).toHaveTextContent(/Visa ending 4242/);
  });
});

describe('★ 17e — 02’s fields, as stored', () => {
  it('a filled profile fills 02’s boxes; PO and language have no column: "—", and why', async () => {
    render(
      await BillingProfileSection({
        profile: billingProfileSchema.parse({
          billingName: 'Aviv & Co. Ltd',
          vatId: '515234781',
          billingAddress: '14 Ha’arba’a, Tel Aviv',
          billingCountry: 'IL',
          billingEmail: 'finance@example.com',
        }),
        methods: [
          { id: 'pm', brand: 'Visa', last4: '4417', isDefault: true, expMonth: 8, expYear: 2028 },
        ],
        failedInvoiceCount: 0,
      }),
    );
    const fields = screen.getByTestId('profile-fields');
    expect(fields).toHaveTextContent('Legal nameAviv & Co. Ltd');
    expect(fields).toHaveTextContent('Company no. / VAT ID515234781');
    const po = screen.getByText('Purchase order / reference').nextElementSibling;
    expect(po).toHaveTextContent(/^—$/);
    expect(po).toHaveAttribute('title', 'GOTCHA has no field for this yet.');
    expect(screen.getByTestId('profile-send-to')).toHaveTextContent('finance@example.com');
    expect(screen.getByTestId('payment-method')).toHaveTextContent('Visa ending 4417');
    expect(screen.getByTestId('payment-method-expiry')).toHaveTextContent('Expires 08/28');
  });
});

describe('★ 17e — every state draws 02’s drawer', () => {
  it('never entered: all six boxes, "No card on file" as a row, the chip area', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: NO_METHODS,
        failedInvoiceCount: 4,
      }),
    );
    expect(screen.getByTestId('payment-method-none')).toHaveTextContent('No card on file');
    expect(screen.getByTestId('nothing-to-charge')).toHaveTextContent(/4 charges/);
    const fields = screen.getByTestId('profile-fields');
    for (const label of [
      'Legal name',
      'Company no. / VAT ID',
      'Address',
      'Country',
      'Purchase order / reference',
      'Invoice language',
    ]) {
      expect(fields).toHaveTextContent(label);
    }
    expect(screen.getByTestId('profile-send-to')).toHaveTextContent('—');
  });

  it('an unread card list is "—" in the row, never "No card on file"', async () => {
    render(
      await BillingProfileSection({ profile: NO_PROFILE, methods: null, failedInvoiceCount: 0 }),
    );
    expect(screen.getByTestId('payment-method-none')).toHaveTextContent(/^—Add card$/);
  });
});
