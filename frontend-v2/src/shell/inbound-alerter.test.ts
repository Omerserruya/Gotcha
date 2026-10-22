import { describe, expect, it, vi } from 'vitest';

import { translate, type RealtimeEvent } from '@/realtime/events';

import { inboundAlerter, type AlerterDeps, type ConversationGlance } from './inbound-alerter';

/**
 * The alerter in order: the cheap rules, the conversation read, the burst.
 * The rules themselves are `decide.test.ts`; this is that they are applied,
 * to the right event, once.
 */
const message = (over: Partial<Extract<RealtimeEvent, { type: 'message.received' }>> = {}) =>
  ({
    type: 'message.received',
    tenantId: 't1',
    at: 0,
    conversationId: 'c1',
    messageId: `m-${Math.random()}`,
    direction: 'INBOUND',
    body: 'Hi, where is my order?',
    messageType: 'text',
    ...over,
  }) as RealtimeEvent;

function harness(over: Partial<AlerterDeps> = {}, glance?: Partial<ConversationGlance>) {
  let now = 1_000_000;
  const chime = vi.fn(() => true);
  const popup = vi.fn();
  const readConversation = vi.fn(async () => ({
    access: 'visible' as const,
    name: 'Dana Levi',
    channel: 'WHATSAPP',
    ...glance,
  }));
  const deps: AlerterDeps = {
    role: () => 'leader',
    settings: () => ({ sound: true, desktop: true }),
    permission: () => 'granted',
    quiet: () => false,
    openConversationId: () => null,
    readConversation,
    chime,
    popup,
    now: () => now,
    ...over,
  };
  return {
    onMessage: inboundAlerter(deps),
    chime,
    popup,
    readConversation,
    advance: (ms: number) => (now += ms),
  };
}

describe('★ an incoming message, end to end', () => {
  it('★ a customer’s message in a background leader: one chime, one popup with what to show', async () => {
    const h = harness();
    await h.onMessage(message());
    expect(h.chime).toHaveBeenCalledTimes(1);
    expect(h.popup).toHaveBeenCalledWith({
      conversationId: 'c1',
      name: 'Dana Levi',
      channel: 'WHATSAPP',
      body: 'Hi, where is my order?',
      messageType: 'text',
      silent: true,
    });
  });

  it('★ the agent’s own reply: nothing, and the conversation is not even read', async () => {
    const h = harness();
    await h.onMessage(message({ direction: 'OUTBOUND' }));
    expect(h.readConversation).not.toHaveBeenCalled();
    expect(h.chime).not.toHaveBeenCalled();
    expect(h.popup).not.toHaveBeenCalled();
  });

  it('★ a system row the platform wrote (INBOUND, messageType system, empty body): nothing', async () => {
    const h = harness();
    await h.onMessage(message({ messageType: 'system', body: '' }));
    // The rule is the type, not the empty body: a system row with words is still not the customer.
    await h.onMessage(message({ messageType: 'system', body: 'Conversation closed' }));
    expect(h.readConversation).not.toHaveBeenCalled();
    expect(h.chime).not.toHaveBeenCalled();
    expect(h.popup).not.toHaveBeenCalled();
  });

  it('★ an empty body with no media kind: nothing to say, nothing said', async () => {
    const h = harness();
    await h.onMessage(message({ messageType: 'text', body: '  ' }));
    expect(h.chime).not.toHaveBeenCalled();
    expect(h.popup).not.toHaveBeenCalled();
  });

  it('a photo with the adapter’s filler body still alerts', async () => {
    const h = harness();
    await h.onMessage(message({ messageType: 'image', body: '[Image]' }));
    expect(h.popup).toHaveBeenCalledTimes(1);
  });

  it('★ a conversation this person may not see (refused): silence', async () => {
    const h = harness({}, { access: 'refused', name: null, channel: null });
    await h.onMessage(message());
    expect(h.readConversation).toHaveBeenCalledWith('c1');
    expect(h.chime).not.toHaveBeenCalled();
    expect(h.popup).not.toHaveBeenCalled();
  });

  it('★ a burst is one chime; the popup still follows each message', async () => {
    const h = harness();
    await h.onMessage(message());
    h.advance(1_000);
    await h.onMessage(message());
    h.advance(1_000);
    await h.onMessage(message());
    expect(h.chime).toHaveBeenCalledTimes(1);
    expect(h.popup).toHaveBeenCalledTimes(3);
    h.advance(3_000);
    await h.onMessage(message());
    expect(h.chime).toHaveBeenCalledTimes(2);
  });

  it('a chime the browser blocked does not start a burst - the next one may sound', async () => {
    const h = harness({ chime: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) });
    await h.onMessage(message());
    h.advance(500);
    await h.onMessage(message());
    expect(h.popup.mock.calls.map((c) => (c[0] as { silent: boolean }).silent)).toEqual([
      false,
      true,
    ]);
  });

  it('★ the same message announced twice alerts once', async () => {
    const h = harness();
    const once = message({ messageId: 'm1' });
    await h.onMessage(once);
    h.advance(10_000);
    await h.onMessage(once);
    expect(h.popup).toHaveBeenCalledTimes(1);
  });

  it('★ quiet hours: nothing, and nothing read', async () => {
    const h = harness({ quiet: () => true });
    await h.onMessage(message());
    expect(h.readConversation).not.toHaveBeenCalled();
    expect(h.chime).not.toHaveBeenCalled();
  });

  it('a focused tab with that conversation open: nothing', async () => {
    const h = harness({ role: () => 'focused', openConversationId: () => 'c1' });
    await h.onMessage(message());
    expect(h.chime).not.toHaveBeenCalled();
    expect(h.popup).not.toHaveBeenCalled();
  });

  it('other event types are not its business', async () => {
    const h = harness();
    await h.onMessage({
      type: 'message.delivery_changed',
      tenantId: 't1',
      at: 0,
      conversationId: 'c1',
      messageId: 'm1',
    });
    expect(h.readConversation).not.toHaveBeenCalled();
  });
});

/*
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ FROM THE WIRE: A NEW CONVERSATION, AND ONE THAT IS NOT OPEN
 * ════════════════════════════════════════════════════════════════════════════
 * The frame the incoming worker publishes for a customer's first message,
 * as the bridge relays it: `{ message, conversationId, channel }` plus the
 * envelope's `tenantId` and the row's id as `messageId`. Nothing in it says
 * "new" - a first message alerts like any other, because the conversation is
 * created (and committed) before the message, and the message before the
 * publish (incoming.worker: findOrCreateOpenConversation, message.create,
 * then publishEvent), so the alerter's read finds it.
 */
describe('★★ through the translator', () => {
  const wire = (conversationId: string, messageId: string) =>
    translate('message:new', {
      message: {
        id: messageId,
        tenantId: 't1',
        conversationId,
        channel: 'INSTAGRAM',
        direction: 'INBOUND',
        body: 'Hi, is this in stock?',
        messageType: 'text',
        status: 'DELIVERED',
        senderName: null,
        createdAt: '2026-10-11T09:00:00.000Z',
      },
      conversationId,
      channel: 'INSTAGRAM',
      tenantId: 't1',
      messageId,
    });

  it('★★ a brand-new conversation’s first message: chime and popup', async () => {
    const event = wire('c-new', 'm-first');
    expect(event).not.toBeNull();
    const h = harness({}, { name: 'yael.k', channel: 'INSTAGRAM' });
    await h.onMessage(event!);
    expect(h.readConversation).toHaveBeenCalledWith('c-new');
    expect(h.chime).toHaveBeenCalledTimes(1);
    expect(h.popup).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-new',
        name: 'yael.k',
        body: 'Hi, is this in stock?',
      }),
    );
  });

  it('★★ a message in a conversation that is not the one open: it alerts', async () => {
    // Looking at v2 with another conversation open: the sound.
    const focused = harness({ role: () => 'focused', openConversationId: () => 'c-open' });
    await focused.onMessage(wire('c-other', 'm1')!);
    expect(focused.chime).toHaveBeenCalledTimes(1);
    // A background tab with one open: the sound and the popup.
    const leader = harness({ openConversationId: () => 'c-open' });
    await leader.onMessage(wire('c-other', 'm2')!);
    expect(leader.chime).toHaveBeenCalledTimes(1);
    expect(leader.popup).toHaveBeenCalledTimes(1);
  });

  it('the same conversation open and focused: nothing (the contrast)', async () => {
    const h = harness({ role: () => 'focused', openConversationId: () => 'c-open' });
    await h.onMessage(wire('c-open', 'm3')!);
    expect(h.chime).not.toHaveBeenCalled();
  });
});
