import { describe, expect, it } from 'vitest';

import {
  agentUnreadIsUnknown,
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

describe('★★ agent-unread does not exist, and the nearest field is a trap', () => {
  it('★★ `readAt` is the CUSTOMER’s receipt and must never mean the agent saw it', () => {
    /*
     * The same word for the opposite party's fact. Reading it as "the agent
     * has seen this" marks a queue read because the CUSTOMER read our reply
     * - the queue would empty itself as customers open their phones.
     */
    const read = message({ readAt: '2026-09-25T11:30:00.000Z' });
    expect(read.readAt).not.toBeNull();
    // There is no agent-side answer to derive, and the helper says so rather
    // than returning a plausible boolean somebody would then render.
    expect(agentUnreadIsUnknown()).toBe(true);
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
    expect(renderableType(message({ messageType: 'shopify_product' }))).toBeNull();
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

describe('★ an old row’s generic "Bot" sender is GOTCHA', () => {
  it.each([
    ['Bot', 'GOTCHA'],
    ['bot', 'GOTCHA'],
    [' Bot ', 'GOTCHA'],
    ['Bot Smith', 'Bot Smith'],
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
