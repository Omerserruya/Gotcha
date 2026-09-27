import { describe, expect, it } from 'vitest';

import {
  agentUnreadIsUnknown,
  conversationRowSchema,
  hasTranscript,
  messageSchema,
  quotedState,
  renderableType,
  waitingMinutes,
  CONVERSATION_STATUSES,
  type InboxMessage,
  channelName,
  channelNameList,
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
     * waiting-on-an-external-system does not exist — so 02b's "11 exchanges
     * held — returns system down" has nothing to derive from.
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
     * — the queue would empty itself as customers open their phones.
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
     * `messageType` is a free String with no enum — the observed values are
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
     * `replyToMessageId` can fail to resolve — the quoted message may
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
     * not — "we have the key" reads like "we have the feature".
     */
    expect(hasTranscript(message({ messageType: 'audio', mediaUrl: 'https://x/a.ogg' }))).toBe(
      false,
    );
  });
});

describe('★★ channelName — one function, because this defect was found twelve times', () => {
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
   * reach for a framework — which is also what makes it testable here with a
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
     *   unguarded key, and next-intl returns the KEY it could not resolve — so an
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
     * recognise", and the inbox queue distinguishes them in its own words — it
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
