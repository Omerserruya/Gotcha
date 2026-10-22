import { describe, expect, it } from 'vitest';

import {
  customerDetailSchema,
  customerListSchema,
  customerRowSchema,
  collapseToPeople,
  isKnownChannel,
  isTruncated,
  labelOfPerson,
  listedCount,
  personLabel,
  reachHandle,
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

describe('collapseToPeople - the design first line, now that it is backed', () => {
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
     * `personId` - to make the collapse visible in evidence - is what exposed
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

/*
 * ★★ Backend 83579ac8: `POST /contacts/segment` answers each row with
 * `displayLabel` (services/conversation/src/routes/contacts.ts), built by
 * lib/contact-label.ts - never an Instagram or Messenger id. The rows below
 * are the shapes that route sends: the Prisma contact spread, plus the label.
 */
const IGSID = '1031990639501705';
const PSID = '7766554433221100';
const segmentRow = (over: Record<string, unknown>) => ({
  id: 'c9',
  tenantId: 't1',
  externalId: IGSID,
  channel: 'INSTAGRAM',
  displayName: null,
  phone: null,
  email: null,
  tags: [],
  metadata: { instagramUsername: 'yael.b' },
  personId: null,
  mergedIntoId: null,
  ...over,
});

describe('★★ displayLabel - what the segment route calls a row (83579ac8)', () => {
  it('parses from the segment response as sent, beside every other field', () => {
    const parsed = customerListSchema.parse({
      data: [
        segmentRow({ displayLabel: 'Instagram customer' }),
        segmentRow({ id: 'c8', displayName: '@yael.b', displayLabel: '@yael.b' }),
      ],
      total: 2,
    });
    expect(parsed.data.map((r) => r.displayLabel)).toEqual(['Instagram customer', '@yael.b']);
  });

  it('absent (an older service, or the detail route) is undefined; a bad value never fails the row', () => {
    expect(customerRowSchema.parse(segmentRow({})).displayLabel).toBeUndefined();
    expect(customerRowSchema.parse(segmentRow({ displayLabel: 42 })).displayLabel).toBeUndefined();
    expect(customerRowSchema.parse(segmentRow({ displayLabel: null })).displayLabel).toBeNull();
  });
});

describe('★★ personLabel - the server’s label, and never a raw external id', () => {
  const parse = (over: Record<string, unknown>) => customerRowSchema.parse(segmentRow(over));

  it('the server’s label is the name', () => {
    expect(personLabel(parse({ displayName: 'Yael Barak', displayLabel: 'Yael Barak' }))).toEqual({
      name: 'Yael Barak',
    });
    expect(personLabel(parse({ displayName: '@yael.b', displayLabel: '@yael.b' }))).toEqual({
      name: '@yael.b',
    });
  });

  it.each([
    ['INSTAGRAM', 'Instagram customer', IGSID],
    ['MESSENGER', 'Messenger customer', PSID],
    ['WEBCHAT', 'Website visitor', 'sess_abc'],
    ['SHOPIFY_LIVE_CHAT', 'Store chat visitor', 'sess_def'],
  ] as const)('%s: its fallback words become ours, never the id', (channel, label, id) => {
    expect(personLabel(parse({ channel, externalId: id, displayLabel: label }))).toEqual({
      generic: channel,
    });
  });

  it('"Customer", the last resort, is ours too; a stored name that happens to read so is a name', () => {
    expect(
      personLabel(parse({ channel: 'SLACK', externalId: '', displayLabel: 'Customer' })),
    ).toEqual({
      generic: 'other',
    });
    expect(personLabel(parse({ displayName: 'Customer', displayLabel: 'Customer' }))).toEqual({
      name: 'Customer',
    });
  });

  it('an older service sends no label: worked out here, and an opaque id is never one', () => {
    expect(personLabel(parse({}))).toEqual({ generic: 'INSTAGRAM' });
    expect(personLabel(parse({ channel: 'MESSENGER', externalId: PSID }))).toEqual({
      generic: 'MESSENGER',
    });
    expect(personLabel(parse({ channel: 'SLACK', externalId: 'U024BE7LH' }))).toBeNull();
    expect(personLabel(parse({ displayName: '  ', email: 'y@x.com' }))).toEqual({
      name: 'y@x.com',
    });
  });

  it('on WhatsApp the id IS the phone, so it may be the label', () => {
    expect(
      personLabel(
        parse({ channel: 'WHATSAPP', externalId: '972541111111', displayLabel: '972541111111' }),
      ),
    ).toEqual({ name: '972541111111' });
    expect(personLabel(parse({ channel: 'WHATSAPP', externalId: '972541111111' }))).toEqual({
      name: '972541111111',
    });
  });

  it('a label that is just an opaque id is no name at all', () => {
    expect(
      personLabel(parse({ channel: 'SLACK', externalId: 'U024BE7LH', displayLabel: 'U024BE7LH' })),
    ).toBeNull();
  });

  it('a person reads by the identity that has a name, whichever was listed first', () => {
    const ig = parse({ displayLabel: 'Instagram customer' });
    const wa = parse({
      id: 'c2',
      channel: 'WHATSAPP',
      externalId: '972541111111',
      displayName: 'Omer Tsruya',
      displayLabel: 'Omer Tsruya',
    });
    expect(labelOfPerson([ig, wa])).toEqual({ name: 'Omer Tsruya' });
    expect(labelOfPerson([ig])).toEqual({ generic: 'INSTAGRAM' });
    expect(labelOfPerson([parse({ channel: 'SLACK', externalId: 'U1' })])).toBeNull();
  });
});

describe('★★ reachHandle - a phone or an address, never an opaque id', () => {
  const parse = (over: Record<string, unknown>) => customerRowSchema.parse(segmentRow(over));
  it('phone, then email, then the id only where it is one of those', () => {
    expect(reachHandle(parse({ phone: '+972541111111', email: 'y@x.com' }))).toBe('+972541111111');
    expect(reachHandle(parse({ email: 'y@x.com' }))).toBe('y@x.com');
    expect(reachHandle(parse({ channel: 'WHATSAPP', externalId: '972541111111' }))).toBe(
      '972541111111',
    );
    expect(reachHandle(parse({}))).toBeNull();
    expect(reachHandle(parse({ channel: 'MESSENGER', externalId: PSID }))).toBeNull();
  });
});
