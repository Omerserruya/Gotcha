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
