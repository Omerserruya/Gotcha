import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { CommerceSummary, Insight } from '@/api/contracts/customer-facts';
import { customerRowSchema, type CustomerRow } from '@/api/contracts/customers';
import { pairKey } from '@/api/contracts/identity';
import messages from '@/i18n/messages/en/customers.json';
import inboxMessages from '@/i18n/messages/en/inbox.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { customers: messages, inbox: inboxMessages },
      namespace: namespace as 'customers',
    }),
  getLocale: async () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerList, ReachOut, Segments, WhoTheyAre } from './CustomerList';
import {
  duplicateSuggestion,
  inSegment,
  peopleToday,
  segmentOf,
  sinceWords,
  type ConversationFact,
} from './people-today';
import { reasonKey } from './row-facts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const row = (over: Record<string, unknown> = {}): CustomerRow =>
  customerRowSchema.parse({
    id: 'k1',
    externalId: '972500000001',
    displayName: 'Dana Cohen',
    channel: 'WHATSAPP',
    phone: '+972500000001',
    ...over,
  });
const conv = (over: Partial<ConversationFact> = {}): ConversationFact => ({
  customerExternalId: '972500000001',
  status: 'OPEN',
  lastMessageAt: '2026-10-04T11:48:00.000Z',
  lastMessageBody: 'Where is order #1842?',
  lastMessageDirection: 'INBOUND',
  ...over,
});

const show = async (
  rows: readonly CustomerRow[],
  conversations: ConversationFact[] | null = [conv()],
  facts: Pick<Parameters<typeof CustomerList>[0], 'commerce' | 'insights'> = {},
) =>
  render(
    await CustomerList({
      people: peopleToday(rows, conversations, null, NOW),
      shownOf: 4180,
      rowsEmpty: rows.length === 0,
      searchedField: null,
      query: '',
      now: NOW,
      ...facts,
    }),
  );

describe('★★ 04’s rows - what is true about them today', () => {
  it('a link to the person: initials, name, their last word, and how long ago', async () => {
    await show([row()]);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/customers/k1');
    expect(link).toHaveTextContent('DC');
    expect(screen.getByTestId('situation-k1')).toHaveTextContent('Where is order #1842?');
    expect(screen.getByTestId('since-k1')).toHaveTextContent('12m ago');
    // The handle moved to the title: how to reach them, not what is true.
    expect(link).toHaveAttribute(
      'title',
      // The phone is its own LTR island: in Hebrew it would lay out backwards.
      `Reach: ${String.fromCharCode(0x2066)}+972500000001${String.fromCharCode(0x2069)}`,
    );
  });

  it('★ open and their word last: "Waiting on you"; answered: no chip - a tag shows instead', async () => {
    const one = await show([row()]);
    expect(screen.getByTestId('waiting-k1')).toHaveTextContent('Waiting on you');
    one.unmount();
    await show([row({ tags: ['Wholesale'] })], [conv({ lastMessageDirection: 'OUTBOUND' })]);
    expect(screen.queryByTestId('waiting-k1')).toBeNull();
    expect(screen.getByTestId('customer-k1')).toHaveTextContent('Wholesale');
  });

  it('no conversation read for them: "-" with why - never "never wrote"', async () => {
    await show([row()], []);
    expect(screen.getByTestId('situation-k1')).toHaveTextContent('-');
    expect(screen.getByTestId('since-k1')).toHaveTextContent('-');
  });

  it('worth unread: "-" with why - no figure nobody read, and no second line', async () => {
    await show([row()]);
    expect(screen.getByTestId('value-k1').textContent).toBe('-');
    expect(screen.getByTestId('value-k1').getAttribute('title')).toBe(
      'The store’s orders couldn’t be read.',
    );
  });

  it('quiet for months: drawn dimmer', async () => {
    await show([row()], [conv({ status: 'CLOSED', lastMessageAt: '2026-05-01T00:00:00.000Z' })]);
    expect(screen.getByTestId('customer-k1')).toHaveAttribute('data-faded', 'yes');
    expect(screen.getByTestId('since-k1')).toHaveTextContent('5 months');
  });

  it('"1 month", never "a month"', async () => {
    await show([row()], [conv({ status: 'CLOSED', lastMessageAt: '2026-09-02T12:00:00.000Z' })]);
    expect(screen.getByTestId('since-k1')).toHaveTextContent(/^1 month$/);
  });

  it('the footer: showing N of all, with the identity limit as its reason', async () => {
    await show([row()]);
    expect(screen.getByTestId('customer-count')).toHaveTextContent(
      'Showing 1 of 4180 · shift-click to pick several, then message or tag them',
    );
    expect(screen.getByTestId('customer-count').getAttribute('title')).toBeTruthy();
  });
});

describe('★★ the three chips - live counts, or none when unread', () => {
  it('counts; the current one marked; links keep the segment in the URL', async () => {
    render(
      await Segments({
        segment: 'talking',
        everyone: 4180,
        talking: 37,
        quiet: { count: 640, capped: false },
      }),
    );
    expect(screen.getByTestId('segment-everyone')).toHaveTextContent('Everyone');
    expect(screen.getByTestId('segment-talking')).toHaveTextContent('Talking to you now · 37');
    expect(screen.getByTestId('segment-quiet')).toHaveTextContent('Gone quiet · 640');
    expect(screen.getByTestId('segment-talking')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('segment-quiet')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/customers', query: { segment: 'quiet' } }),
    );
  });

  it('unread: the label alone - never "· 0"; capped: "100+"', async () => {
    render(
      await Segments({
        segment: 'everyone',
        everyone: 3,
        talking: null,
        quiet: { count: 100, capped: true },
      }),
    );
    expect(screen.getByTestId('segment-talking')).toHaveTextContent(/^Talking to you now$/);
    expect(screen.getByTestId('segment-quiet')).toHaveTextContent('Gone quiet · 100+');
  });
});

describe('★★ the side column', () => {
  it.each([
    [null, "We couldn't read who has gone quiet."],
    [{ count: 0, capped: false }, 'Nobody has gone quiet.'],
    [{ count: 3, capped: false }, '3 people wrote to you more than once, then went quiet.'],
  ] as const)('reach out: %o → %s', async (quiet, words) => {
    render(await ReachOut({ quiet }));
    expect(screen.getByTestId('reach-out')).toHaveTextContent(words);
  });

  it('reach out: to a draft campaign, and to the list', async () => {
    render(await ReachOut({ quiet: { count: 3, capped: false } }));
    expect(screen.getByTestId('reach-write')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/outreach', query: { create: 'campaign' } }),
    );
    expect(screen.getByTestId('reach-list')).toHaveAttribute(
      'href',
      JSON.stringify({ pathname: '/customers', query: { segment: 'quiet' } }),
    );
  });

  it('who they are, unread: label and "-" on a line, an empty bar under each, why on the card', async () => {
    render(await WhoTheyAre());
    const card = screen.getByTestId('who-they-are');
    expect(card.textContent).not.toMatch(/\d/);
    const rows = card.querySelectorAll('li');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.children[0]).toHaveTextContent('Bought once-');
    expect(rows[0]!.children[1]?.getAttribute('aria-hidden')).toBe('true');
    expect(rows[0]!.children[1]?.children).toHaveLength(0);
    expect(card.getAttribute('title')).toBe('The store’s orders couldn’t be read.');
  });

  it('★ who they are, read: four counts, each bar its share of everyone', async () => {
    render(
      await WhoTheyAre({
        segments: {
          source: 'woocommerce',
          reason: null,
          truncated: false,
          total: 200,
          counts: { bought_once: 100, came_back: 50, wholesale: 10, never_bought: 40 },
        },
      }),
    );
    expect(screen.getByTestId('who-bought')).toHaveTextContent('Bought once100');
    const fill = (key: string) =>
      screen.getByTestId(`who-${key}`).querySelector<HTMLElement>('[data-tone]')!;
    expect(fill('bought').style.inlineSize).toBe('50%');
    expect(fill('wholesale').style.inlineSize).toBe('5%');
    expect(fill('wholesale')).toHaveAttribute('data-tone', 'wholesale');
    expect(screen.getByTestId('who-they-are')).not.toHaveAttribute('title');
  });

  it('★ who they are, no store: "-" with the reason - never four zeros', async () => {
    render(
      await WhoTheyAre({
        segments: {
          source: null,
          reason: 'no_store_connected',
          truncated: false,
          total: 0,
          counts: null,
        },
      }),
    );
    const card = screen.getByTestId('who-they-are');
    expect(card.textContent).not.toMatch(/\d/);
    expect(card.getAttribute('title')).toBe(
      'No store is connected, so there are no orders to count.',
    );
  });
});

describe('★★ the join that makes a row "today"', () => {
  it('a person’s every identity counts; the newest word wins; any open conversation is "talking"', () => {
    const rows = [
      row({ id: 'a', personId: 'p1', externalId: 'wa-1' }),
      row({ id: 'b', personId: 'p1', externalId: 'ig-1', channel: 'INSTAGRAM' }),
    ];
    const [dana] = peopleToday(
      rows,
      [
        conv({
          customerExternalId: 'wa-1',
          status: 'CLOSED',
          lastMessageAt: '2026-10-01T00:00:00Z',
          lastMessageBody: 'old',
        }),
        conv({
          customerExternalId: 'ig-1',
          status: 'OPEN',
          lastMessageAt: '2026-10-04T10:00:00Z',
          lastMessageBody: 'new',
        }),
      ],
      new Set(['wa-1']),
      NOW,
    );
    expect(dana).toMatchObject({ situation: 'new', talking: true, waiting: true, quiet: true });
  });

  it('sorted by last contact; nobody read last', () => {
    const people = peopleToday(
      [
        row({ id: 'z', externalId: 'z' }),
        row({ id: 'y', externalId: 'y' }),
        row({ id: 'x', externalId: 'x' }),
      ],
      [
        conv({ customerExternalId: 'y', lastMessageAt: '2026-10-03T00:00:00Z' }),
        conv({ customerExternalId: 'x', lastMessageAt: '2026-10-04T00:00:00Z' }),
      ],
      null,
      NOW,
    );
    expect(people.map((p) => p.primary.id)).toEqual(['x', 'y', 'z']);
  });

  it('★ "talking now" is open AND a word in the last 24 hours; waiting needs only open + theirs', () => {
    const [stale] = peopleToday(
      [row()],
      [
        conv({
          status: 'OPEN',
          lastMessageAt: '2026-09-04T12:00:00Z',
          lastMessageDirection: 'INBOUND',
        }),
      ],
      null,
      NOW,
    );
    expect(stale).toMatchObject({ talking: false, waiting: true });
    const [fresh] = peopleToday(
      [row()],
      [conv({ lastMessageAt: '2026-10-03T13:00:00Z' })],
      null,
      NOW,
    );
    expect(fresh?.talking).toBe(true);
  });

  it('segments: from the URL, and who is in them', () => {
    expect(segmentOf('talking')).toBe('talking');
    expect(segmentOf('nonsense')).toBe('everyone');
    const [p] = peopleToday([row()], [conv({ status: 'CLOSED' })], null, NOW);
    expect(inSegment(p!, 'talking')).toBe(false);
    expect(inSegment(p!, 'quiet')).toBe(false);
    expect(inSegment(p!, 'everyone')).toBe(true);
  });

  it.each([
    ['2026-10-04T11:58:00Z', '2m ago'],
    ['2026-10-04T09:00:00Z', '3h ago'],
    ['2026-10-03T06:00:00Z', 'Yesterday'],
    ['2026-09-30T12:00:00Z', '4 days'],
  ])('since %s → %s', (at, words) => {
    const { key, n } = sinceWords(at, NOW);
    const t = createTranslator({
      locale: 'en',
      messages: { customers: messages, inbox: inboxMessages },
      namespace: 'customers',
    });
    expect(t(`since.${key}` as 'since.days', { n: n ?? 0 })).toBe(words);
  });

  it('★★ 04: a pair marked "not the same" is never suggested - either way round - and the next one is', () => {
    const rows = [
      row({ id: 'a', phone: '0500000001', personId: null }),
      row({ id: 'b', phone: '+972500000001', personId: null }),
      row({ id: 'c', phone: '0500000002', personId: null }),
      row({ id: 'd', phone: '0500000002', personId: null }),
    ];
    expect(duplicateSuggestion(rows, new Set(['a|b']))?.map((r) => r.id)).toEqual(['c', 'd']);
    // The route sorts; a key made the other way round is the same pair.
    expect(duplicateSuggestion(rows, new Set([pairKey('b', 'a')]))?.map((r) => r.id)).toEqual([
      'c',
      'd',
    ]);
    expect(duplicateSuggestion(rows, new Set(['a|b', 'c|d']))).toBeNull();
  });

  it('★ duplicates: a shared phone or email between people not already joined', () => {
    expect(
      duplicateSuggestion([
        row({ id: 'a', phone: '+972-50-000-0001', personId: null }),
        row({ id: 'b', phone: '0500000001', personId: null, channel: 'SMS' }),
      ])?.map((r) => r.id),
    ).toEqual(['a', 'b']);
    // Already one person: nothing to suggest. Merged away: not a candidate.
    expect(
      duplicateSuggestion([row({ id: 'a', personId: 'p' }), row({ id: 'b', personId: 'p' })]),
    ).toBeNull();
    expect(duplicateSuggestion([row({ id: 'a' }), row({ id: 'b', mergedIntoId: 'a' })])).toBeNull();
    expect(
      duplicateSuggestion([
        row({ id: 'a', phone: null, email: 'Yael@Shop.com' }),
        row({ id: 'b', phone: null, email: 'yael@shop.com ' }),
      ]),
    ).not.toBeNull();
  });
});

const read = (byId: Record<string, Partial<CommerceSummary>>, truncated = false) =>
  ({
    state: 'read',
    truncated,
    byId: new Map(
      Object.entries(byId).map(([id, s]) => [
        id,
        { lifetimeValue: 0, currency: 'ILS', orderCount: 0, lastOrderAt: null, ...s },
      ]),
    ),
  }) as const;
const insight = (over: Partial<Insight> = {}): Insight => ({
  conversationId: 'c1',
  situation: null,
  inboundCount: 1,
  mood: null,
  ...over,
});

describe('★★ 04’s value column - the amount over its orders, or "-" with why', () => {
  const value = () => screen.getByTestId('value-k1');

  it('read: "₪2,140" over "6 orders"', async () => {
    await show([row()], undefined, {
      commerce: read({ k1: { lifetimeValue: 2140, orderCount: 6 } }),
    });
    expect(value().textContent).toBe('₪2,1406 orders');
    expect(value()).not.toHaveAttribute('title');
  });

  it('read, none: "-" over "no orders yet"', async () => {
    await show([row()], undefined, { commerce: read({ k1: {} }) });
    expect(value().textContent).toBe('-no orders yet');
  });

  it('★ capped and none: "-" with why - an older order may be past the cap', async () => {
    await show([row()], undefined, { commerce: read({ k1: {} }, true) });
    expect(value().textContent).toBe('-');
    expect(value().getAttribute('title')).toMatch(/newest orders/);
  });

  it('★ no store: "-" with the reason - never "no orders yet"', async () => {
    await show([row()], undefined, {
      commerce: { state: 'none', reason: 'no_store_connected' },
    });
    expect(value().textContent).toBe('-');
    expect(value()).not.toHaveTextContent('no orders yet');
    expect(value().getAttribute('title')).toBe(
      'No store is connected, so there are no orders to read.',
    );
  });

  it('★ mixed currencies: the route withholds the sum (0) - "-" over the orders, not "0"', async () => {
    await show([row()], undefined, {
      commerce: read({ k1: { lifetimeValue: 0, currency: null, orderCount: 3 } }),
    });
    expect(value().textContent).toBe('-3 orders');
    expect(value().getAttribute('title')).toMatch(/more than one currency/);
  });

  it('★ two identities: the one with most orders speaks - the same phone’s orders are never summed', async () => {
    await show(
      [row({ personId: 'p1' }), row({ id: 'k2', personId: 'p1', externalId: 'other' })],
      undefined,
      {
        commerce: read({
          k1: { lifetimeValue: 500, orderCount: 2 },
          k2: { lifetimeValue: 900, orderCount: 3 },
        }),
      },
    );
    expect(screen.getByTestId(/^value-/).textContent).toBe('₪9003 orders');
  });

  it('a reason nobody wrote a sentence for reads as unread, not as a key', () => {
    expect(reasonKey('something_new')).toBe('unread');
    expect(reasonKey('store_unreachable')).toBe('store_unreachable');
  });
});

describe('★★ 04’s second line and chip, from their open conversation', () => {
  it('situation · "wrote 3 times"; a mood chip over "waiting on you"', async () => {
    await show([row()], [conv({ lastMessageDirection: 'INBOUND' })], {
      insights: new Map([
        [
          'k1',
          insight({ situation: 'Waiting on order #1842', inboundCount: 3, mood: 'frustrated' }),
        ],
      ]),
    });
    expect(screen.getByTestId('situation-k1')).toHaveTextContent(
      'Waiting on order #1842 · wrote 3 times',
    );
    expect(screen.getByTestId('mood-k1')).toHaveTextContent('Frustrated today');
    expect(screen.getByTestId('mood-k1')).toHaveAttribute('data-tone', 'frustrated');
    expect(screen.queryByTestId('waiting-k1')).toBeNull();
  });

  it('once: no "wrote"; about to buy is green; no situation: their last word, as before', async () => {
    const one = await show([row()], undefined, {
      insights: new Map([
        ['k1', insight({ situation: 'Asking about the sand king', mood: 'about_to_buy' })],
      ]),
    });
    // The line is the situation alone - no "wrote" for a first message.
    expect(screen.getByTestId('situation-k1').querySelector('bdi')!.textContent).toBe(
      'Asking about the sand king',
    );
    expect(screen.getByTestId('mood-k1')).toHaveTextContent('About to buy');
    one.unmount();
    await show([row()], undefined, { insights: new Map([['k1', insight()]]) });
    expect(screen.getByTestId('situation-k1')).toHaveTextContent(conv().lastMessageBody!);
  });

  it('Hebrew sits in its own direction', async () => {
    await show([row()], undefined, {
      insights: new Map([['k1', insight({ situation: 'בקשה להחזר' })]]),
    });
    expect(screen.getByTestId('situation-k1').querySelector('bdi')).toHaveTextContent('בקשה להחזר');
  });

  it('★ measured on dev: only the situation is in its own direction - "wrote N times" stays after it', async () => {
    await show([row()], undefined, {
      insights: new Map([
        ['k1', insight({ situation: 'היי, מחפש מידע על מוצר', inboundCount: 2 })],
      ]),
    });
    const bdi = screen.getByTestId('situation-k1').querySelector('bdi')!;
    expect(bdi.textContent).toBe('היי, מחפש מידע על מוצר');
    expect(bdi).toHaveAttribute('dir', 'auto');
    expect(bdi.nextSibling?.textContent).toBe(' · wrote 2 times');
    // Its own element, so a long situation is cut and this is not.
    expect(bdi.nextSibling?.nodeName).toBe('SPAN');
  });
});
