import { fireEvent, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { billingProfileSchema, type PaymentMethod } from '@/api/contracts/billing-profile';
import messages from '@/i18n/messages/en/billing.json';

/* The editable form is a client component with its own tests; here, when it is drawn and with what. */
vi.mock('./ProfileForm', () => ({
  ProfileForm: ({ profile }: { profile: { billingName: string | null } }) => (
    <div data-testid="profile-form" data-name={profile.billingName ?? ''} />
  ),
}));

import { BillingProfileSection } from './BillingProfile';

/**
 * The warning that used to vanish.
 *
 * This block depends on TWO parallel reads and failed roughly one capture in
 * six - a different viewport each run, with a clear request budget. The
 * condition was `methods !== null && ...`, so a lost payment-methods fetch
 * removed the whole warning and left a page that looked complete.
 *
 * A capture cannot cover this: it needs a fetch to fail, and the one time in
 * six that it did, it presented as a flake.
 */

/* The deployment's switch: off (dev - the live payment account) unless a test turns it on. */
const writes = vi.hoisted(() => ({ on: false }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));
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
     * There IS no payment method - that much was read. The failure count was
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

describe('★ 17e - 02’s fields, as stored', () => {
  it('a filled profile is the editable form; its card is said', async () => {
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
    // A record that exists is edited in place (17e's Save, database only).
    expect(screen.getByTestId('profile-form')).toHaveAttribute('data-name', 'Aviv & Co. Ltd');
    expect(screen.queryByTestId('profile-fields')).toBeNull();
    expect(screen.getByTestId('payment-method')).toHaveTextContent('Visa ending 4417');
    expect(screen.getByTestId('payment-method-expiry')).toHaveTextContent('Expires 08/28');
  });
});

describe('★ 17e - every state draws 02’s drawer', () => {
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
    expect(screen.getByTestId('profile-send-to')).toHaveTextContent('-');
  });

  it('an unread card list is "-" in the row, never "No card on file"', async () => {
    render(
      await BillingProfileSection({ profile: NO_PROFILE, methods: null, failedInvoiceCount: 0 }),
    );
    expect(screen.getByTestId('payment-method-none')).toHaveTextContent(/^-Add card$/);
  });
});

describe('★★ 17e card - opens its confirm and holds (the session creates a client on the live provider account)', () => {
  it('no card: Add card says it saves one for future charges, nothing now; Yes is a status', async () => {
    render(
      await BillingProfileSection({ profile: NO_PROFILE, methods: [], failedInvoiceCount: 0 }),
    );
    fireEvent.click(screen.getByTestId('add-card'));
    expect(screen.getByTestId('add-card-confirm')).toHaveTextContent(
      "This opens the payment provider's secure page to save a card. It's kept for future charges - nothing is charged now.",
    );
    const yes = screen.getByTestId('add-card-yes');
    expect(yes.tagName).toBe('SPAN');
    expect(yes).toHaveAttribute('aria-disabled', 'true');
    expect(yes).toHaveTextContent('Not available here');
  });

  it('a card: Replace names the card it replaces', async () => {
    render(
      await BillingProfileSection({
        profile: NO_PROFILE,
        methods: [
          { id: 'pm', brand: 'Visa', last4: '4417', isDefault: true, expMonth: 8, expYear: 2028 },
        ],
        failedInvoiceCount: 0,
      }),
    );
    fireEvent.click(screen.getByTestId('replace-card'));
    expect(screen.getByTestId('replace-card-confirm')).toHaveTextContent(
      'save a new card in place of Visa ending 4417; the new one is charged from then on. Nothing is charged now.',
    );
    expect(screen.getByTestId('replace-card-yes')).toHaveAttribute('aria-disabled', 'true');
  });
});
