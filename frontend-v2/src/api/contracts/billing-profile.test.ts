import { describe, expect, it } from 'vitest';

import {
  billingProfileResponseSchema,
  billingProfileSchema,
  hasSomethingToCharge,
  isBlank,
  paymentMethodListSchema,
  profileReading,
  cardExpiry,
} from './billing-profile';

describe('no profile is not an empty profile', () => {
  it('keeps a missing profile null rather than filling it with blanks', () => {
    /*
     * A tenant that has never entered billing details has no row at all.
     * Rendering blank fields for both states would tell someone whose
     * details were deleted that they never filled them in.
     */
    expect(billingProfileResponseSchema.parse({ data: null })).toBeNull();
  });

  it('parses a real profile', () => {
    const p = billingProfileResponseSchema.parse({
      data: { billingName: 'Aviv & Co', vatId: '514213265', currency: 'ILS' },
    });
    expect(p?.vatId).toBe('514213265');
  });

  it('tells a blank profile from an absent one', () => {
    expect(isBlank(null)).toBe(false);
    expect(isBlank(billingProfileSchema.parse({}))).toBe(true);
    expect(isBlank(billingProfileSchema.parse({ vatId: '1' }))).toBe(false);
  });
});

describe('the sixth envelope', () => {
  it('unwraps { paymentMethods }', () => {
    expect(paymentMethodListSchema.parse({ paymentMethods: [{ id: 'pm1' }] })).toHaveLength(1);
  });
});

describe('whether there is anything to charge', () => {
  it('is false with no method on file', () => {
    /*
     * Arithmetic, not diagnosis: a card that does not exist cannot be
     * charged. On this tenant that sits beside four FAILED invoices.
     */
    expect(hasSomethingToCharge([])).toBe(false);
  });

  it('is true once one exists', () => {
    expect(
      hasSomethingToCharge([
        { id: 'pm1', brand: 'visa', last4: '4242', isDefault: true, expMonth: null, expYear: null },
      ]),
    ).toBe(true);
  });
});

describe('the profile carries nothing the design invented', () => {
  it('has one billing email, not a list of recipients', () => {
    // "Send invoices to finance@ and to the owner" is not expressible, and a
    // second field that quietly overwrote the first would be worse than none.
    const surface = Object.keys(billingProfileSchema.parse({}));
    expect(surface).toContain('billingEmail');
    expect(surface.filter((k) => /recipients|emails|cc\b/i.test(k))).toEqual([]);
  });

  it('has no PO number and no profile language', () => {
    const surface = Object.keys(billingProfileSchema.parse({}));
    expect(surface.filter((k) => /poNumber|purchaseOrder|language|locale/i.test(k))).toEqual([]);
  });
});

describe('four things blank billing fields can mean', () => {
  const profile = (over: Record<string, unknown> = {}) =>
    billingProfileSchema.parse({ state: 'present', ...over });

  it('★ no billable entity is not “you have not filled this in”', () => {
    /*
     * The sharpest of the four: with no account, "add your billing details"
     * is not even the right instruction - there is nothing to add them to.
     */
    expect(profileReading(profile({ state: 'no_billable_entity' }))).toBe('no_account');
  });

  it('separates never-entered from emptied', () => {
    // The route's comment: "`present` with every field null means EMPTIED,
    // which is a different thing from `no_billing_profile`."
    expect(profileReading(profile({ state: 'no_billing_profile' }))).toBe('never_entered');
    expect(profileReading(profile({ state: 'present' }))).toBe('emptied');
  });

  it('reads a filled profile as filled', () => {
    expect(profileReading(profile({ billingName: 'GOTCHA Ltd' }))).toBe('filled');
  });

  it('defaults `state` to present so a pre-fix response still parses', () => {
    // `present` says least; it asserts no absence the old payload never made.
    expect(billingProfileSchema.parse({}).state).toBe('present');
  });

  it('treats a null payload as never-entered rather than guessing', () => {
    expect(profileReading(null)).toBe('never_entered');
  });
});

describe('★ 17e - the card’s expiry, as the route sends it', () => {
  it('keeps expMonth / expYear and writes them as 02 does', () => {
    const [card] = paymentMethodListSchema.parse({
      paymentMethods: [
        { id: 'pm', brand: 'Visa', last4: '4417', expMonth: 8, expYear: 2028, isDefault: true },
      ],
    });
    expect(cardExpiry(card!)).toBe('08/28');
  });

  it('says nothing when half of it is missing', () => {
    const [card] = paymentMethodListSchema.parse({
      paymentMethods: [{ id: 'pm', brand: 'Visa', last4: '4417', expMonth: 8 }],
    });
    expect(cardExpiry(card!)).toBeNull();
  });
});
