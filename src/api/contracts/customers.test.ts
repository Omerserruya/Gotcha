import { describe, expect, it } from 'vitest';

import {
  customerDetailSchema,
  customerLabel,
  customerListSchema,
  customerRowSchema,
  collapseToPeople,
  isKnownChannel,
  isTruncated,
  listedCount,
  type CustomerRow,
} from './customers';

/**
 * The rulings on screen 04, as assertions.
 *
 * This tenant has two contacts with no tags and no dates, so a capture can
 * exercise almost none of this. These tests are where the judgements live.
 */

const row: CustomerRow = {
  id: 'c1',
  externalId: '+972500000000',
  displayName: 'Dana Cohen',
  channel: 'WHATSAPP',
  phone: '+972500000000',
  email: null,
  tags: [],
  lastInteractionAt: null,
  source: null,
  personId: null,
  mergedIntoId: null,
};

describe('the contract strips what no list needs', () => {
  it('drops metadata, opt-out state and the tenant id', () => {
    // The detail route spreads the whole Prisma row, and `metadata` is
    // arbitrary tenant-supplied JSON.
    const parsed = customerRowSchema.parse({
      ...row,
      metadata: { passport: 'X1234567' },
      optOutChannels: ['WHATSAPP'],
      tenantId: 't1',
      updatedAt: '2026-09-20T00:00:00.000Z',
    });

    for (const key of ['metadata', 'optOutChannels', 'tenantId', 'updatedAt'])
      expect(parsed, `${key} must not survive the contract`).not.toHaveProperty(key);
  });

  it('KEEPS personId and mergedIntoId, which is what makes this a list of people', () => {
    // These two were requested and landed 2026-09-20. Before that, one human
    // on two channels was two rows and a merged-away row was still listed.
    // Stripping them here would put the screen back where it was.
    const parsed = customerRowSchema.parse({ ...row, personId: 'p1', mergedIntoId: null });
    expect(parsed.personId).toBe('p1');
    expect(parsed).toHaveProperty('mergedIntoId');
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

  it('calls the list truncated only when the page was actually filled', () => {
    expect(isTruncated(500)).toBe(true);
    expect(isTruncated(2)).toBe(false);
    expect(isTruncated(0)).toBe(false);
  });

  it('does not report truncation when the count merely includes tombstones', () => {
    // The route's `count` has no `mergedIntoId: null` filter while its
    // `findMany` does, so on a tenant that has ever merged the total exceeds
    // the list with nothing truncated. Trusting `total > shown` would render
    // "showing 2 of 3" with no third person to show.
    expect(isTruncated(2)).toBe(false);
    expect(listedCount(2, 3)).toBe(2);
  });

  it('falls back to the server total only once the page is full', () => {
    expect(listedCount(500, 812)).toBe(812);
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

describe('collapseToPeople — the design first line, now that it is backed', () => {
  const at = (over: Partial<typeof row>) => ({ ...row, ...over });

  it('collapses one human on two channels into one person', () => {
    const people = collapseToPeople([
      at({ id: 'a', channel: 'WHATSAPP', personId: 'p1' }),
      at({ id: 'b', channel: 'INSTAGRAM', personId: 'p1' }),
    ]);
    expect(people).toHaveLength(1);
    expect(people[0]!.channels).toEqual(['WHATSAPP', 'INSTAGRAM']);
  });

  it('never merges rows that merely both lack a personId', () => {
    // Absence means "not known to be the same human", never "the same as the
    // others". Treating null as a group key would fuse every unlinked contact
    // on the tenant into a single person.
    const people = collapseToPeople([
      at({ id: 'a', personId: null }),
      at({ id: 'b', personId: null }),
    ]);
    expect(people).toHaveLength(2);
  });

  it('keeps the first row as the one shown', () => {
    const people = collapseToPeople([
      at({ id: 'a', displayName: 'Dana Cohen', personId: 'p1' }),
      at({ id: 'b', displayName: 'dana c', personId: 'p1' }),
    ]);
    expect(people[0]!.primary.displayName).toBe('Dana Cohen');
  });

  it('is what the header must count, not the row array', () => {
    /*
     * The defect this replaced: the header counted contact ROWS under a label
     * reading "people", so three rows collapsed to two people on screen and
     * the header still said three.
     *
     * The real two contacts on this tenant both had distinct identities, so
     * the count and the list agreed BY ACCIDENT. Giving two fixtures a shared
     * `personId` — to make the collapse visible in evidence — is what exposed
     * it. The fixture proved something nothing was asserting.
     */
    const rows = [
      at({ id: 'a', channel: 'WHATSAPP', personId: 'p1' }),
      at({ id: 'b', channel: 'INSTAGRAM', personId: 'p1' }),
      at({ id: 'c', channel: 'EMAIL', personId: null }),
    ];
    expect(rows).toHaveLength(3);
    expect(collapseToPeople(rows)).toHaveLength(2);
  });

  it('does not repeat a channel a person uses twice', () => {
    const people = collapseToPeople([
      at({ id: 'a', channel: 'WHATSAPP', personId: 'p1' }),
      at({ id: 'b', channel: 'WHATSAPP', personId: 'p1' }),
    ]);
    expect(people[0]!.channels).toEqual(['WHATSAPP']);
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
