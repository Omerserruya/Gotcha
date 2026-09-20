import { describe, expect, it } from 'vitest';

import {
  customerDetailSchema,
  customerLabel,
  customerListSchema,
  customerRowSchema,
  isKnownChannel,
  isTruncated,
} from './customers';

/**
 * The rulings on screen 04, as assertions.
 *
 * This tenant has two contacts with no tags and no dates, so a capture can
 * exercise almost none of this. These tests are where the judgements live.
 */

const row = {
  id: 'c1',
  externalId: '+972500000000',
  displayName: 'Dana Cohen',
  channel: 'WHATSAPP',
  phone: '+972500000000',
  email: null,
  tags: [],
  lastInteractionAt: null,
  source: null,
};

describe('the contract strips what no list needs', () => {
  it('drops metadata, personId, mergedIntoId and opt-out state', () => {
    // The detail route spreads the whole Prisma row, and `metadata` is
    // arbitrary tenant-supplied JSON.
    const parsed = customerRowSchema.parse({
      ...row,
      metadata: { passport: 'X1234567' },
      optOutChannels: ['WHATSAPP'],
      personId: 'p1',
      mergedIntoId: 'c9',
      tenantId: 't1',
    });

    for (const key of ['metadata', 'optOutChannels', 'personId', 'mergedIntoId', 'tenantId'])
      expect(parsed, `${key} must not survive the contract`).not.toHaveProperty(key);
  });

  it('keeps historyByChannel on the detail, which is the cheap half of 04c', () => {
    const detail = customerDetailSchema.parse({
      ...row,
      avatarUrl: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      historyByChannel: { WHATSAPP: 3, EMAIL: 1 },
    });
    expect(detail.historyByChannel).toEqual({ WHATSAPP: 3, EMAIL: 1 });
  });
});

describe('the total is the count, not the page', () => {
  it('keeps both, because unwrapping data would throw the count away', () => {
    const parsed = customerListSchema.parse({ data: [row], total: 812 });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.total).toBe(812);
  });

  it('knows when the list is shorter than the count', () => {
    // The route counts everything and returns at most 500, so a screen that
    // showed the count beside a shorter list would misdescribe it.
    expect(isTruncated(500, 812)).toBe(true);
    expect(isTruncated(2, 2)).toBe(false);
    expect(isTruncated(0, 0)).toBe(false);
  });
});

describe('customerLabel — a handle beats a placeholder', () => {
  it('prefers the name when there is one', () => {
    expect(customerLabel(row)).toBe('Dana Cohen');
  });

  it('falls back to the phone, which on WhatsApp is how they are known', () => {
    expect(customerLabel({ ...row, displayName: null })).toBe('+972500000000');
  });

  it('falls back to email, then to the channel handle', () => {
    expect(
      customerLabel({ ...row, displayName: null, phone: null, email: 'dana@example.com' }),
    ).toBe('dana@example.com');
    expect(
      customerLabel({ ...row, displayName: null, phone: null, email: null, externalId: 'psid-9' }),
    ).toBe('psid-9');
  });

  it('returns null rather than a placeholder when there is genuinely nothing', () => {
    // The caller says so in words; inventing "Unknown" here would make an
    // absence look like a value.
    expect(
      customerLabel({ displayName: '  ', phone: null, email: null, externalId: '' }),
    ).toBeNull();
  });
});

describe('an unrecognised channel still renders', () => {
  it('recognises the ones we have words for', () => {
    expect(isKnownChannel('WHATSAPP')).toBe(true);
    expect(isKnownChannel('TELEGRAM')).toBe(true);
  });

  it('reports an unknown channel as unknown rather than dropping the row', () => {
    // Same call as `riskTags` on approvals: hiding a row because we cannot
    // translate its channel would hide a customer.
    expect(isKnownChannel('SIGNAL')).toBe(false);
    expect(customerRowSchema.parse({ ...row, channel: 'SIGNAL' }).channel).toBe('SIGNAL');
  });
});

describe('a row carries no field that could become a false claim', () => {
  it('exposes nothing resembling value, orders or tenure', () => {
    // All three are two live uncached Shopify calls per customer, and none is
    // on `Contact`. A field here is how one of them creeps into a list.
    const surface = Object.keys(customerRowSchema.parse(row));
    expect(surface.filter((k) => /value|spend|orders?|lifetime|tenure|since/i.test(k))).toEqual([]);
  });

  it('carries lastInteractionAt, which is effectively always null', () => {
    // Kept because the writer is requested. Nothing may present it as
    // recency until something initialises it.
    expect(customerRowSchema.parse(row).lastInteractionAt).toBeNull();
  });
});
