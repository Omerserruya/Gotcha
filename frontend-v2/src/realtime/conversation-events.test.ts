import { describe, expect, it, vi } from 'vitest';

import type { RealtimeEvent } from './events';
import { translate } from './events';
import { SocketTransport } from './socket-transport';

/**
 * The conversation events the inbox list re-reads on, as the platform sends
 * them - every frame below is one an emitter in ChatCenter `services/` writes
 * (2026-10-11), after the bridge (`conversation/src/lib/socket-bridge.ts`):
 * a socket receives the bus event's `data`, plus the envelope's `tenantId`
 * when `data` has none.
 */

/** The row `emitToTenant` sends (conversation.service): the whole Prisma row, flat. */
const serviceRow = {
  id: 'c1',
  tenantId: 't1',
  channel: 'INSTAGRAM',
  customerExternalId: '178414',
  customerName: 'Dana Levi',
  assignedAgentId: 'u1',
  assignedAiAgentId: null,
  departmentId: null,
  status: 'OPEN',
  isHandedOver: true,
  handledBy: 'human',
  lastMessageAt: '2026-10-11T09:00:00.000Z',
  assignedAgent: { id: 'u1', name: 'Noa', email: 'noa@example.com' },
};

describe('★★ conversation:updated - every shape the emitters send', () => {
  it.each([
    ['conversation.service emitToTenant (claim, transfer, release, stop AI…)', serviceRow],
    // incoming.worker: `{ ...conversation, channel }` - the row, relayed.
    ['the incoming worker, on every inbound message', { ...serviceRow, channel: 'INSTAGRAM' }],
    // idle worker / flow end: `{ id, status: "CLOSED" }` + the bridge's tenant.
    ['a close announced as an update', { id: 'c1', status: 'CLOSED', tenantId: 't1' }],
    // routing.service.
    ['routing', { id: 'c1', departmentId: 'd1', assignedAgentId: null, tenantId: 't1' }],
    // ai-bot closed-hours reply, idle reminder: the id alone.
    ['the bare id', { id: 'c1', tenantId: 't1' }],
    // ai-bot escalation.
    [
      'an escalation',
      { id: 'c1', isHandedOver: true, status: 'WAITING', escalationCase: 'x', tenantId: 't1' },
    ],
    // shopify-chat-public handoff: `channel` is a channel type, not a room.
    [
      'the Shopify chat handoff',
      {
        id: 'c1',
        isHandedOver: true,
        status: 'WAITING',
        channel: 'SHOPIFY_LIVE_CHAT',
        tenantId: 't1',
      },
    ],
  ])('★ %s', (_, frame) => {
    expect(translate('conversation:updated', frame)).toEqual({
      type: 'conversation.updated',
      tenantId: 't1',
      at: expect.any(Number),
      conversationId: 'c1',
    });
  });

  it('★ the envelope shape too (`{ tenantId, data }`), as the other translators accept', () => {
    expect(
      translate('conversation:updated', { tenantId: 't1', data: { id: 'c1', status: 'OPEN' } }),
    ).toMatchObject({ type: 'conversation.updated', tenantId: 't1', conversationId: 'c1' });
  });

  it('★★ read / unread, to the viewer’s own `user:<id>` room (Backend 0190bd4e)', () => {
    /*
     * Marking a conversation read or unread is announced to that person's other
     * tabs, flat, with both ids. It is the same event and the same re-read, so
     * the badge clears everywhere they are signed in.
     */
    expect(
      translate('conversation:updated', {
        id: 'c1',
        conversationId: 'c1',
        tenantId: 't1',
        unread: false,
        unreadCount: 0,
        lastReadAt: '2026-10-11T09:30:00.000Z',
        markedUnread: false,
      }),
    ).toEqual({
      type: 'conversation.updated',
      tenantId: 't1',
      at: expect.any(Number),
      conversationId: 'c1',
    });
  });

  it('★★ a frame with no tenant is dropped - it depends on the bridge adding one', () => {
    /*
     * The bus publishers leave the tenant on the envelope; only the bridge's
     * `withIdentity` puts it on the frame. Without it, this is unattributable,
     * and the transport would drop it anyway.
     */
    expect(translate('conversation:updated', { id: 'c1', status: 'CLOSED' })).toBeNull();
    expect(translate('conversation:updated', { tenantId: 't1', status: 'CLOSED' })).toBeNull();
    expect(translate('conversation:updated', null)).toBeNull();
  });

  it('⚠ a non-object `data` does not stand in for the frame', () => {
    expect(
      translate('conversation:updated', { id: 'c1', tenantId: 't1', data: 'x' }),
    ).toMatchObject({ conversationId: 'c1' });
  });

  it('★ the dotted name is ours, not the wire’s', () => {
    expect(translate('conversation.updated', serviceRow)).toBeNull();
  });
});

describe('★★ conversation:closed', () => {
  it('★ conversation.service close: the row', () => {
    expect(translate('conversation:closed', { ...serviceRow, status: 'CLOSED' })).toEqual({
      type: 'conversation.closed',
      tenantId: 't1',
      at: expect.any(Number),
      conversationId: 'c1',
    });
  });

  it('★★ the WhatsApp handoff: `{ conversationId, reason }` and no `id`', () => {
    expect(
      translate('conversation:closed', {
        conversationId: 'c2',
        reason: 'continued_on_whatsapp',
        tenantId: 't1',
      }),
    ).toMatchObject({ type: 'conversation.closed', conversationId: 'c2' });
  });

  it('the AI bot: both, the same id', () => {
    expect(
      translate('conversation:closed', {
        id: 'c3',
        conversationId: 'c3',
        channel: 'WHATSAPP',
        status: 'CLOSED',
        tenantId: 't1',
      }),
    ).toMatchObject({ type: 'conversation.closed', conversationId: 'c3' });
  });

  it('the idle worker: `{ id, status }` + the bridge’s tenant', () => {
    expect(
      translate('conversation:closed', { id: 'c4', status: 'CLOSED', tenantId: 't1' }),
    ).toMatchObject({ type: 'conversation.closed', conversationId: 'c4' });
  });
});

describe('★ the chain still answers each name with its own translator', () => {
  it('message:new is still a message, not a conversation change', () => {
    expect(
      translate('message:new', {
        message: { id: 'm1', tenantId: 't1', conversationId: 'c1', direction: 'INBOUND' },
        conversationId: 'c1',
        channel: 'INSTAGRAM',
        tenantId: 't1',
        messageId: 'm1',
      }),
    ).toMatchObject({ type: 'message.received', conversationId: 'c1', messageId: 'm1' });
  });
});

/* ── Through the transport: the tenant filter applies to these too ── */

type Handler = (...args: unknown[]) => void;
const fake = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const socket = {
    connected: true,
    on: (event: string, h: Handler) => handlers.set(event, h),
    onAny: (h: Handler) => handlers.set('*', h),
    emit: () => undefined,
    removeAllListeners: () => undefined,
    disconnect: () => undefined,
  };
  return { handlers, socket };
});
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

describe('★★ another workspace’s conversation never reaches a listener', () => {
  it('★★ a frame for t2 on a t1 socket is dropped; t1’s is delivered', async () => {
    const transport = new SocketTransport({
      url: 'wss://x',
      tenantId: 't1',
      credentials: async () => ({ ticket: 'k' }),
    });
    transport.connect();
    await Promise.resolve();
    await Promise.resolve();
    const heard: RealtimeEvent[] = [];
    transport.on('conversation.updated', (event) => heard.push(event));
    transport.on('conversation.closed', (event) => heard.push(event));

    const frame = fake.handlers.get('*')!;
    frame('conversation:updated', { ...serviceRow, tenantId: 't2' });
    frame('conversation:closed', { id: 'c9', status: 'CLOSED', tenantId: 't2' });
    expect(heard).toEqual([]);

    frame('conversation:updated', serviceRow);
    frame('conversation:closed', { id: 'c9', status: 'CLOSED', tenantId: 't1' });
    expect(heard.map((e) => e.type)).toEqual(['conversation.updated', 'conversation.closed']);
  });
});
