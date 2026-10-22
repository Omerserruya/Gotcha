import { describe, expect, it } from 'vitest';

import {
  parseUnreadCounts,
  parseViewTotals,
  rowIsUnread,
  unreadCountsSchema,
  unreadMark,
  conversationRowSchema,
  hasTranscript,
  messageSchema,
  quotedState,
  senderLabel,
  renderableType,
  waitingMinutes,
  CONVERSATION_STATUSES,
  type InboxMessage,
  channelName,
  channelNameList,
  deliveryOf,
} from './inbox';

const NOW = new Date('2026-09-25T12:00:00.000Z');

const message = (over: Record<string, unknown> = {}): InboxMessage =>
  messageSchema.parse({
    id: 'm1',
    direction: 'INBOUND',
    createdAt: '2026-09-25T11:00:00.000Z',
    ...over,
  });

describe('★★ the state machine is three, not the design’s five', () => {
  it('★★ has no waiting-on-a-broken-system state to hang 02b on', () => {
    /*
     * `ConversationStatus` is OPEN | WAITING | CLOSED. Waiting-on-customer
     * and waiting-on-business are one undifferentiated WAITING, and
     * waiting-on-an-external-system does not exist - so 02b's "11 exchanges
     * held - returns system down" has nothing to derive from.
     */
    expect([...CONVERSATION_STATUSES]).toEqual(['OPEN', 'WAITING', 'CLOSED']);
    expect(CONVERSATION_STATUSES).not.toContain('HELD');
    expect(CONVERSATION_STATUSES).not.toContain('WAITING_ON_CUSTOMER');
  });
});

describe('★★ agent-unread is the server’s per-person answer, and nothing else', () => {
  const parse = (over: Record<string, unknown>) =>
    conversationRowSchema.parse({ id: 'c1', status: 'OPEN', ...over });

  it('★★ `unread`: absent is "not said", true and false are kept, garbage is "not said"', () => {
    expect(parse({}).unread).toBeUndefined();
    expect(parse({ unread: true }).unread).toBe(true);
    expect(parse({ unread: false }).unread).toBe(false);
    // ⚠ A malformed value never rejects the list, and never becomes a dot.
    expect(parse({ unread: 'yes' }).unread).toBeUndefined();
    expect(parse({ unread: 1 }).unread).toBeUndefined();
    expect(parse({ unread: null }).unread).toBeUndefined();
  });

  it('★ `unreadCount`: a whole number ≥ 0, or "not said" - never a default 0', () => {
    expect(parse({}).unreadCount).toBeUndefined();
    expect(parse({ unreadCount: 3 }).unreadCount).toBe(3);
    expect(parse({ unreadCount: 0 }).unreadCount).toBe(0);
    expect(parse({ unreadCount: -1 }).unreadCount).toBeUndefined();
    expect(parse({ unreadCount: 2.5 }).unreadCount).toBeUndefined();
    expect(parse({ unreadCount: '3' }).unreadCount).toBeUndefined();
  });

  it('★ `lastReadAt` is kept when sent, and a bad one is dropped, not fatal', () => {
    expect(parse({ lastReadAt: '2026-10-11T08:00:00.000Z' }).lastReadAt).toBe(
      '2026-10-11T08:00:00.000Z',
    );
    expect(parse({ lastReadAt: null }).lastReadAt).toBeNull();
    expect(parse({ lastReadAt: 42 }).lastReadAt).toBeUndefined();
  });

  it('★★ the mark: a count when counted, a dot when only flagged, else nothing', () => {
    expect(unreadMark({ unreadCount: 4 })).toEqual({ kind: 'count', count: 4 });
    expect(unreadMark({ unread: true, unreadCount: 4 })).toEqual({ kind: 'count', count: 4 });
    expect(unreadMark({ unread: true })).toEqual({ kind: 'dot' });
    // Marked unread by hand, nothing new to count: still a dot.
    expect(unreadMark({ unread: true, unreadCount: 0 })).toEqual({ kind: 'dot' });
    expect(unreadMark({ unreadCount: 0 })).toBeNull();
    expect(unreadMark({ unread: false })).toBeNull();
    expect(unreadMark({})).toBeNull();
  });

  it('★★ never inferred: INBOUND-last and the customer’s `readAt` say nothing about it', () => {
    /*
     * The same word for the opposite party's fact. Reading `readAt` as "the
     * agent has seen this" marks a queue read because the CUSTOMER read our
     * reply - and INBOUND-last is "nobody answered", which everyone sees alike.
     */
    const read = message({ readAt: '2026-09-25T11:30:00.000Z' });
    expect(read.readAt).not.toBeNull();
    const waiting = parse({ lastMessageDirection: 'INBOUND', lastMessageAt: NOW.toISOString() });
    expect(rowIsUnread(waiting)).toBe(false);
    expect(rowIsUnread(parse({ unread: true }))).toBe(true);
    expect(rowIsUnread(parse({ unreadCount: 2 }))).toBe(true);
  });
});

describe('★★ unread counts per view: a number per view, or none - never a 0 by default', () => {
  const views = ['queue', 'mine', 'active'] as const;

  it('keeps whole non-negative numbers for the views asked about', () => {
    const body = unreadCountsSchema.parse({ queue: 3, mine: 0, other: 9 });
    expect(parseUnreadCounts(body, views)).toEqual({ queue: 3, mine: 0 });
  });

  it('⚠ drops what is not a count, per view, rather than all of them', () => {
    const body = unreadCountsSchema.parse({ queue: '3', mine: -1, active: 1.5 });
    expect(parseUnreadCounts(body, views)).toEqual({});
    expect(parseUnreadCounts({ queue: 2, mine: 'x' }, views)).toEqual({ queue: 2 });
  });

  it('★ the totals object is not a view: unread reads only the views asked about', () => {
    const body = unreadCountsSchema.parse({ queue: 1, totals: { queue: 4 } });
    expect(parseUnreadCounts(body, views)).toEqual({ queue: 1 });
  });
});

describe('★★ each view’s size, from the same answer - absent is no total, never a 0', () => {
  const views = ['queue', 'mine', 'active'] as const;

  it('★★ the live answer (Backend a3d07d09), as the client unwraps it', () => {
    // GET /api/conversations/unread-counts?views=queue,mine,active,gotcha,all, verbatim `data`.
    const live = {
      queue: 0,
      mine: 1,
      active: 1,
      gotcha: 1,
      all: 2,
      totals: { queue: 0, mine: 3, active: 2, gotcha: 11, all: 90 },
    };
    const all = ['queue', 'mine', 'active', 'gotcha', 'all'] as const;
    const body = unreadCountsSchema.parse(live);
    expect(parseUnreadCounts(body, all)).toEqual({
      queue: 0,
      mine: 1,
      active: 1,
      gotcha: 1,
      all: 2,
    });
    expect(parseViewTotals(body, all)).toEqual({
      queue: 0,
      mine: 3,
      active: 2,
      gotcha: 11,
      all: 90,
    });
  });

  it('★ reads `totals` beside the unread keys, a real 0 kept', () => {
    const body = unreadCountsSchema.parse({
      queue: 2,
      mine: 1,
      totals: { queue: 2, mine: 5, active: 0, other: 9 },
    });
    expect(parseViewTotals(body, views)).toEqual({ queue: 2, mine: 5, active: 0 });
  });

  it('⚠⚠ an old backend with no `totals` gives no total for any view - not 0s', () => {
    expect(parseViewTotals(unreadCountsSchema.parse({ queue: 2, mine: 1 }), views)).toEqual({});
  });

  it.each([null, 'many', 7, true])(
    '⚠ a `totals` that is not an object (%s) gives none',
    (totals) => {
      expect(parseViewTotals({ queue: 2, totals }, views)).toEqual({});
    },
  );

  it('⚠ a negative, fractional or non-number total drops that view only', () => {
    const body = { totals: { queue: -1, mine: 2.5, active: '3' } };
    expect(parseViewTotals(body, views)).toEqual({});
    expect(parseViewTotals({ totals: { queue: -4, mine: 6 } }, views)).toEqual({ mine: 6 });
  });
});

describe('★★ waiting is computable; first-reply is not', () => {
  it('ages a row from its last message', () => {
    const row = conversationRowSchema.parse({
      id: 'c1',
      status: 'OPEN',
      lastMessageAt: '2026-09-25T11:46:00.000Z',
    });
    expect(waitingMinutes(row, NOW)).toBe(14);
  });

  it('★ a row with no last message has no age, not zero', () => {
    // Zero would sort a never-touched conversation to the top of "waiting
    // longest" as though it were the most urgent thing in the queue.
    const row = conversationRowSchema.parse({ id: 'c1', status: 'OPEN' });
    expect(waitingMinutes(row, NOW)).toBeNull();
  });

  it('never goes negative on a clock skew', () => {
    const row = conversationRowSchema.parse({
      id: 'c1',
      status: 'OPEN',
      lastMessageAt: '2026-09-25T12:05:00.000Z',
    });
    expect(waitingMinutes(row, NOW)).toBe(0);
  });
});

describe('★★ an unconstrained messageType is not a domain', () => {
  it('★★ returns null for a type nobody has accounted for', () => {
    /*
     * `messageType` is a free String with no enum - the observed values are
     * what writers happen to have written. An exhaustive switch turns an
     * unknown into whatever the default branch says, and a default of
     * "system message" would mislabel the next type somebody adds.
     */
    // (shopify_product was this example until W9b drew product cards.)
    expect(renderableType(message({ messageType: 'poll_v9' }))).toBeNull();
    expect(renderableType(message({ messageType: 'woo_product' }))).toBe('woo_product');
    expect(renderableType(message({ messageType: 'voice_final' }))).toBeNull();
    expect(renderableType(message({ messageType: 'text' }))).toBe('text');
  });

  it('is not fooled by case or padding', () => {
    expect(renderableType(message({ messageType: ' Image ' }))).toBe('image');
  });
});

describe('★★ a reply whose quote we never stored is still a reply', () => {
  it('★★ keeps the provider id when our lookup missed', () => {
    /*
     * `replyToMessageId` can fail to resolve - the quoted message may
     * predate GOTCHA or have been deleted. Rendering that as an ordinary
     * message loses the fact that the customer was answering something,
     * which is often the only thing making it legible.
     */
    expect(quotedState(message({ replyToExternalId: 'wamid.x' }))).toBe('unresolved');
    expect(quotedState(message({ replyToExternalId: 'wamid.x', replyToMessageId: 'm0' }))).toBe(
      'resolved',
    );
    expect(quotedState(message())).toBe('none');
  });
});

describe('★★ the voice note cannot be read out', () => {
  it('★★ says so for every message, including an audio one', () => {
    /*
     * "Read what she said" has nothing behind it. An inbound voice note is
     * stored as a file; the only audio-specific code in the worker is a
     * filename extension. The Deepgram credential exists and the client does
     * not - "we have the key" reads like "we have the feature".
     */
    expect(hasTranscript(message({ messageType: 'audio', mediaUrl: 'https://x/a.ogg' }))).toBe(
      false,
    );
  });
});

describe('★★ channelName - one function, because this defect was found twelve times', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * TWELVE SITES, SIX OF THEM FOUND AFTER THE FIRST THREE WERE "FIXED"
   * ════════════════════════════════════════════════════════════════════════════
   * A raw channel enum reaching a reader was repaired at the inbox queue, Home's
   * rows, Home's channel bar, Home's insight sentence, the inbox identity panel,
   * the automations list, the AI employees list, the campaign card, the customer
   * timeline, the channels screen, the connect panel and the connectable row.
   *
   * Every one of them had hand-written the same three lines. **A pattern copied
   * at twelve sites is a function nobody wrote yet**, and the thirteenth would be
   * written by somebody who had read none of the comments.
   *
   * The translator is passed in because this module is a contract and must not
   * reach for a framework - which is also what makes it testable here with a
   * plain function instead of a renderer.
   */
  const catalogue = new Set([
    'WHATSAPP',
    'MESSENGER',
    'INSTAGRAM',
    'EMAIL',
    'GMAIL',
    'OUTLOOK',
    'SLACK',
    'VOICE',
    'WEBCHAT',
    'SHOPIFY_LIVE_CHAT',
    'other',
  ]);
  /** Stands in for the `channels` namespace translator, and fails loudly. */
  const t = (key: 'name.WHATSAPP' | 'name.other'): string => {
    const value = key.slice('name.'.length);
    if (!catalogue.has(value)) throw new Error(`no such key: ${key}`);
    return `«${value}»`;
  };

  it('names a channel the catalogue knows', () => {
    expect(channelName('WHATSAPP', t)).toBe('«WHATSAPP»');
    expect(channelName('SHOPIFY_LIVE_CHAT', t)).toBe('«SHOPIFY_LIVE_CHAT»');
  });

  it('★★ says "another channel" for one it does not, rather than asking for a key', () => {
    /*
     * ★ THIS IS THE ASSERTION THAT COVERS THE THREE WORST SITES. `ChannelList`,
     *   `ConnectPanel` and `ConnectableRow` called the translator with an
     *   unguarded key, and next-intl returns the KEY it could not resolve - so an
     *   unlisted channel rendered `name.TELEGRAM`, which is worse than the enum.
     *
     * The stub throws on an unknown key for exactly that reason: a stub that
     * politely returned something would let the defect pass.
     */
    expect(channelName('TELEGRAM', t)).toBe('«other»');
    expect(() => t('name.TELEGRAM' as 'name.WHATSAPP')).toThrow();
  });

  it('★★ returns null for absent, which is not "another channel"', () => {
    /*
     * Three states. "We were not told which channel" is not "a channel we do not
     * recognise", and the inbox queue distinguishes them in its own words - it
     * can only do that if this returns something distinguishable.
     */
    expect(channelName(null, t)).toBeNull();
    expect(channelName(undefined, t)).toBeNull();
    expect(channelName('', t)).toBeNull();
  });

  it('names every channel in a list', () => {
    expect(channelNameList(['WHATSAPP', 'EMAIL'], t)).toEqual(['«WHATSAPP»', '«EMAIL»']);
  });

  it('★★ collapses several unknown channels into one "another channel"', () => {
    /*
     * An employee on three channels the catalogue has never heard of should not
     * read "Another channel · Another channel · Another channel", which says
     * three times over that we do not know something.
     */
    expect(channelNameList(['TELEGRAM', 'SIGNAL', 'WHATSAPP'], t)).toEqual([
      '«other»',
      '«WHATSAPP»',
    ]);
  });

  it('★ drops an empty entry from a list rather than rendering a gap', () => {
    expect(channelNameList(['', 'WHATSAPP'], t)).toEqual(['«WHATSAPP»']);
  });
});

describe('★★ deliveryOf - pending and failed were the same rendering: silence', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════
   * THE CONTRACT CARRIED THE TIMESTAMPS AND NOT THE STATUS
   * ════════════════════════════════════════════════════════════════════════════
   * `deliveredAt` and `readAt` have always been named, so a delivered message
   * could be told from an undelivered one. **A FAILED message has no timestamp
   * either**, so it looked exactly like one still on its way - and the stream
   * showed nothing for both.
   *
   * `Message.status` was on the wire the entire time: the list route puts no
   * `select` on the row and `z.object` stripped it. Third time this week.
   */
  const out = (over: Record<string, unknown> = {}) =>
    ({ direction: 'OUTBOUND' as const, ...over }) as Parameters<typeof deliveryOf>[0];

  it('★★ FAILED wins over any timestamp', () => {
    /*
     * A failure is not undone by a timestamp recorded before the provider
     * rejected it. This is the assertion that would catch somebody "simplifying"
     * the order to read the timestamps first.
     */
    expect(deliveryOf(out({ status: 'FAILED', deliveredAt: '2026-09-27T10:00:00Z' }))).toBe(
      'failed',
    );
    expect(deliveryOf(out({ status: 'FAILED', readAt: '2026-09-27T10:00:00Z' }))).toBe('failed');
  });

  it('prefers a specific timestamp over a column that may not have caught up', () => {
    expect(deliveryOf(out({ status: 'SENT', readAt: '2026-09-27T10:00:00Z' }))).toBe('read');
    expect(deliveryOf(out({ status: 'PENDING', deliveredAt: '2026-09-27T10:00:00Z' }))).toBe(
      'delivered',
    );
  });

  it('reads the status when there is no timestamp yet', () => {
    expect(deliveryOf(out({ status: 'PENDING' }))).toBe('pending');
    expect(deliveryOf(out({ status: 'SENT' }))).toBe('sent');
  });

  it('★★ an unrecognised status is UNKNOWN, never "on its way"', () => {
    /*
     * The house pattern for a status column is `z.enum(...).catch('PENDING')`,
     * and it is wrong on this field: catching an unrecognised failure to
     * `PENDING` renders it as **"still sending"** - the reassuring direction, on
     * the one field whose job is to stop somebody believing a message arrived.
     */
    expect(deliveryOf(out({ status: 'REJECTED_BY_PROVIDER' }))).toBe('unknown');
    expect(deliveryOf(out({ status: '' }))).toBe('unknown');
  });

  it('★★ an ABSENT status is unknown, not pending', () => {
    /*
     * A deploy that does not send the field must not be indistinguishable from
     * one reporting a message on its way. `.optional()` rather than a default is
     * what preserves that, and this is the assertion that keeps somebody from
     * adding the default back.
     */
    expect(deliveryOf(out({}))).toBe('unknown');
    expect(deliveryOf(out({ status: undefined }))).toBe('unknown');
  });

  it('★★ says nothing at all about an inbound message', () => {
    /*
     * `status` on an inbound row describes OUR ingestion, not anything a reader
     * can act on, and a "delivered" marker beside the customer's own words would
     * be nonsense.
     */
    expect(deliveryOf({ direction: 'INBOUND', status: 'PENDING' })).toBeNull();
    expect(deliveryOf({ direction: 'INBOUND', status: 'FAILED' })).toBeNull();
  });

  it('★ tolerates a lower-case status from a service that sends one', () => {
    expect(deliveryOf(out({ status: 'failed' }))).toBe('failed');
    expect(deliveryOf(out({ status: ' Delivered ' }))).toBe('delivered');
  });

  it('★★ the schema leaves an absent status ABSENT, and does not default it', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * A MUTATION SURVIVED HERE, AND THIS IS THE TEST IT SURVIVED THROUGH
     * ════════════════════════════════════════════════════════════════════════
     * Changing `.optional()` to `.default('PENDING')` passed every other test in
     * this file, because they all call `deliveryOf` with a hand-built object and
     * never go through the schema. So the one place the default would take
     * effect was the one place nothing looked.
     *
     * A deploy that does not send the field must not be indistinguishable from
     * one reporting a message on its way. Absent is not pending.
     */
    const parsed = messageSchema.parse({
      id: 'm1',
      direction: 'OUTBOUND',
      createdAt: '2026-09-27T10:00:00Z',
    });
    expect(parsed.status).toBeUndefined();
    expect(deliveryOf(parsed)).toBe('unknown');
  });

  it('★★ the schema keeps the status instead of stripping it', () => {
    /*
     * The defect itself, asserted at the boundary. A `z.object` that does not
     * name the field drops it silently, and from inside this codebase that is
     * indistinguishable from the platform not sending it.
     */
    const parsed = messageSchema.parse({
      id: 'm1',
      direction: 'OUTBOUND',
      createdAt: '2026-09-27T10:00:00Z',
      status: 'FAILED',
    });
    expect(parsed.status).toBe('FAILED');
    expect(deliveryOf(parsed)).toBe('failed');
  });
});

describe('★★ the contract keeps what the stream draws', () => {
  it('★★ `replyTo` and `senderName` survive parsing - `z.object` stripped both', () => {
    const parsed = messageSchema.parse({
      id: 'm1',
      direction: 'OUTBOUND',
      body: 'x',
      createdAt: '2026-09-25T09:14:00.000Z',
      senderName: 'Support AI',
      replyTo: {
        id: 'm0',
        body: null,
        direction: 'INBOUND',
        messageType: 'image',
        senderName: null,
      },
    });
    expect(parsed.senderName).toBe('Support AI');
    expect(parsed.replyTo).toEqual({
      id: 'm0',
      body: '',
      direction: 'INBOUND',
      messageType: 'image',
      senderName: null,
    });
  });

  it('★ and both are optional - an older service sends neither', () => {
    const parsed = messageSchema.parse({ id: 'm1', direction: 'INBOUND', createdAt: 'x' });
    expect(parsed.replyTo).toBeNull();
    expect(parsed.senderName).toBeNull();
  });
});

describe('★ an old row’s generic "Bot" or "AI Bot" sender is GOTCHA', () => {
  it.each([
    ['Bot', 'GOTCHA'],
    ['bot', 'GOTCHA'],
    [' Bot ', 'GOTCHA'],
    ['AI Bot', 'GOTCHA'],
    ['ai bot', 'GOTCHA'],
    ['Bot Smith', 'Bot Smith'],
    ['AI Botanist', 'AI Botanist'],
    ['My AI Bot', 'My AI Bot'],
    ['Support AI', 'Support AI'],
  ])('%j → %j', (senderName, expected) => {
    expect(senderLabel({ direction: 'OUTBOUND', senderName })).toBe(expected);
  });

  it('an inbound "Bot" is still the customer - no label', () => {
    expect(senderLabel({ direction: 'INBOUND', senderName: 'Bot' })).toBeNull();
  });
});

describe('⚠ senderLabel - a login email is not a name', () => {
  it.each([
    ['OUTBOUND', 'Support AI', 'Support AI'],
    ['OUTBOUND', 'dana@shop.co.il', null],
    ['OUTBOUND', '   ', null],
    ['OUTBOUND', null, null],
    ['INBOUND', 'Dana Cohen', null],
  ] as const)('%s %j → %j', (direction, senderName, expected) => {
    expect(senderLabel({ direction, senderName })).toBe(expected);
  });
});

describe('★★ lastMessageType - kept as written, and never the reason a row is lost', () => {
  const parse = (over: Record<string, unknown>) =>
    conversationRowSchema.parse({ id: 'c1', status: 'OPEN', ...over });

  it('★ keeps the type the route sends', () => {
    expect(parse({ lastMessageType: 'image' }).lastMessageType).toBe('image');
  });

  it('★★ an unknown type is a string, not a rejected row', () => {
    // messageType is a free String on the model: `voice_final`, `email`, `template` all exist.
    expect(parse({ lastMessageType: 'shopify_product' }).lastMessageType).toBe('shopify_product');
  });

  it('★ absent (an older service) and null both read as null', () => {
    expect(parse({}).lastMessageType).toBeNull();
    expect(parse({ lastMessageType: null }).lastMessageType).toBeNull();
  });

  it('⚠ a value that is not a string is null, and the row still parses', () => {
    const parsed = conversationRowSchema.safeParse({
      id: 'c1',
      status: 'OPEN',
      lastMessageType: 7,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.lastMessageType).toBeNull();
  });
});

describe('★★ metadata.media survives parsing, and a bad fact never costs the message (Backend 9e68eb03)', () => {
  const withMedia = (media: unknown) =>
    messageSchema.safeParse({
      id: 'm1',
      direction: 'INBOUND',
      createdAt: '2026-10-10T09:00:00.000Z',
      messageType: 'document',
      metadata: { mediaError: 'download_failed', media },
    });

  it('★★ kept as written - a z.object that does not name it strips it', () => {
    const media = {
      mimeType: 'application/pdf',
      byteSize: 2411724,
      originalName: 'Quote 2026.pdf',
    };
    const parsed = withMedia(media);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.metadata?.media).toEqual(media);
    // Its neighbours are untouched.
    expect(parsed.data?.metadata?.mediaError).toBe('download_failed');
  });

  it('★ a failed download: type and name, size null', () => {
    const parsed = withMedia({
      mimeType: 'application/pdf',
      byteSize: null,
      originalName: 'a.pdf',
    });
    expect(parsed.data?.metadata?.media).toEqual({
      mimeType: 'application/pdf',
      byteSize: null,
      originalName: 'a.pdf',
    });
  });

  it.each([
    ['a negative size', { byteSize: -1 }, 'byteSize'],
    ['a size as text', { byteSize: '2048' }, 'byteSize'],
    ['a name that is not text', { originalName: 42 }, 'originalName'],
    ['a type that is not text', { mimeType: ['application/pdf'] }, 'mimeType'],
  ] as const)('★ %s becomes null; the message and the other facts still parse', (_, bad, field) => {
    const parsed = withMedia({
      mimeType: 'image/webp',
      byteSize: 2048,
      originalName: 'x.webp',
      ...bad,
    });
    expect(parsed.success).toBe(true);
    const media = parsed.data?.metadata?.media as Record<string, unknown>;
    expect(media[field]).toBeNull();
    const kept = { mimeType: 'image/webp', byteSize: 2048, originalName: 'x.webp' };
    for (const [k, v] of Object.entries(kept)) if (k !== field) expect(media[k]).toBe(v);
  });

  it.each([
    ['a string', 'application/pdf'],
    ['null', null],
    ['an array', [1, 2]],
  ])('★ media that is %s is dropped, never the message', (_, media) => {
    const parsed = withMedia(media);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.metadata?.media).toBeUndefined();
    expect(parsed.data?.metadata?.mediaError).toBe('download_failed');
  });

  it('absent (a row from before it) is fine', () => {
    const parsed = messageSchema.safeParse({
      id: 'm1',
      direction: 'INBOUND',
      createdAt: '2026-10-10T09:00:00.000Z',
      metadata: { systemEvent: 'agent_claimed' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.metadata?.media).toBeUndefined();
  });

  it('★ a sticker keeps its own type through the contract', () => {
    const parsed = messageSchema.parse({
      id: 'm9',
      direction: 'INBOUND',
      createdAt: '2026-10-10T09:00:00.000Z',
      messageType: 'sticker',
      body: '[Sticker]',
      mediaUrl: '/api/uploads/x.webp',
      metadata: { media: { mimeType: 'image/webp', byteSize: 2048, originalName: null } },
    });
    expect(renderableType(parsed)).toBe('sticker');
    expect(parsed.metadata?.media?.originalName).toBeNull();
  });
});
