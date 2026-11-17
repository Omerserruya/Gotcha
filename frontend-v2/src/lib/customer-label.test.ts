import { describe, expect, it } from 'vitest';

import { customerLabel, customerLabelText, phoneForReading } from './customer-label';

/*
 * Prod 2026-11-17: ~2,676 conversations with no `customerName` read "Someone"
 * in the list and on the phone, while the alerts showed the handle. One chain.
 */
describe('★★ a phone handle, as a person reads it', () => {
  it.each([
    ['972521234567', '052-123-4567'],
    ['+972521234567', '052-123-4567'],
    ['0521234567', '052-123-4567'],
    ['97231234567', '03-123-4567'],
    ['972771234567', '077-123-4567'],
  ])('Israel: %s → %s', (handle, read) => {
    expect(phoneForReading('WHATSAPP', handle)).toBe(read);
  });

  it('another country keeps its digits as one run, with a plus', () => {
    expect(phoneForReading('WHATSAPP', '15551234567')).toBe('+15551234567');
    expect(phoneForReading('WHATSAPP', '447911123456')).toBe('+447911123456');
  });

  it('another channel’s handle is shown as it came', () => {
    expect(phoneForReading('INSTAGRAM', '17841400000000000')).toBe('17841400000000000');
    expect(phoneForReading('MESSENGER', '972521234567')).toBe('972521234567');
    expect(phoneForReading(null, '972521234567')).toBe('972521234567');
  });

  it('a WhatsApp handle that is not a phone is not reshaped', () => {
    expect(phoneForReading('WHATSAPP', 'wa-group-1')).toBe('wa-group-1');
    expect(phoneForReading('whatsapp', '1234')).toBe('1234');
  });
});

describe('★★ the chain: name → handle → nothing', () => {
  it('a name wins', () => {
    expect(
      customerLabel({ customerName: ' דנה ', customerExternalId: '972521234567', channel: 'WHATSAPP' }),
    ).toEqual({ kind: 'name', name: 'דנה' });
  });

  it('no name: the handle, formatted', () => {
    expect(
      customerLabel({ customerName: null, customerExternalId: '972521234567', channel: 'WHATSAPP' }),
    ).toEqual({ kind: 'handle', handle: '052-123-4567' });
    expect(
      customerLabel({ customerName: '   ', customerExternalId: '972521234567', channel: 'WHATSAPP' }),
    ).toEqual({ kind: 'handle', handle: '052-123-4567' });
  });

  it('a stored name that is only the digits is a handle', () => {
    expect(
      customerLabel({ customerName: '972521234567', customerExternalId: null, channel: 'WHATSAPP' }),
    ).toEqual({ kind: 'handle', handle: '052-123-4567' });
  });

  it('a stored shopper is still a name (PersonName words it)', () => {
    const shopper = 'Shopper on demo.myshopify.com';
    expect(customerLabel({ customerName: shopper, channel: 'SHOPIFY_LIVE_CHAT' })).toEqual({
      kind: 'name',
      name: shopper,
    });
  });

  it('an Instagram handle as it came', () => {
    expect(customerLabelText({ customerExternalId: 'igsid-42', channel: 'INSTAGRAM' })).toBe('igsid-42');
  });

  it('neither: null, and only then the caller says "Someone"', () => {
    expect(customerLabel({ customerName: null, customerExternalId: null, channel: 'WHATSAPP' })).toBeNull();
    expect(customerLabel({ customerName: '', customerExternalId: ' ', channel: 'WHATSAPP' })).toBeNull();
    expect(customerLabelText({})).toBeNull();
  });
});
