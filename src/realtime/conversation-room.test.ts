import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from './events';
import { SocketTransport } from './socket-transport';

/**
 * The conversation room - and the event that only travels in it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ v2 NEVER ASKED FOR A ROOM, SO NOTHING SENT TO ONE EVER ARRIVED
 * ════════════════════════════════════════════════════════════════════════════
 * The platform sends per-conversation events - the Copilot's suggestions, a
 * tool's lifecycle - to `conv:{id}`, and joins a socket to it only on
 * `subscribe:conversation`. Our transport never emitted that, so every such
 * event was dropped before it reached a listener, and from inside the app that
 * looks exactly like the platform not sending it.
 */

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  const state = {
    connected: false,
    handlers: new Map<string, Handler>(),
    emitted: [] as { event: string; payload: unknown; ack?: unknown }[],
  };
  const socket = {
    get connected() {
      return state.connected;
    },
    on: (event: string, h: Handler) => state.handlers.set(event, h),
    onAny: (h: Handler) => state.handlers.set('*', h),
    emit: (event: string, payload: unknown, ack?: unknown) =>
      state.emitted.push({ event, payload, ack }),
    removeAllListeners: () => undefined,
    disconnect: () => undefined,
  };
  return { state, socket };
});
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

const connectNow = async () => {
  const transport = new SocketTransport({
    url: 'wss://x',
    tenantId: 't1',
    credentials: async () => ({ ticket: 'k' }),
  });
  transport.connect();
  await Promise.resolve();
  await Promise.resolve();
  return transport;
};
const connectEvent = () => {
  fake.state.connected = true;
  fake.state.handlers.get('connect')?.();
};
const joins = () =>
  fake.state.emitted.filter((e) => e.event === 'subscribe:conversation').map((e) => e.payload);
const leaves = () =>
  fake.state.emitted.filter((e) => e.event === 'unsubscribe:conversation').map((e) => e.payload);

beforeEach(() => {
  fake.state.connected = false;
  fake.state.handlers.clear();
  fake.state.emitted.length = 0;
});

describe('★★ joinConversation', () => {
  it('★★ asks for the room once connected - and again after every reconnect', async () => {
    const transport = await connectNow();
    transport.joinConversation('c1');
    expect(joins()).toEqual([]); // not connected yet: nothing to ask on

    connectEvent();
    expect(joins()).toEqual([{ conversationId: 'c1' }]);

    // A reconnect is a new socket server-side: the room is gone until asked again.
    connectEvent();
    expect(joins()).toEqual([{ conversationId: 'c1' }, { conversationId: 'c1' }]);
  });

  it('asks at once when already connected', async () => {
    const transport = await connectNow();
    connectEvent();
    transport.joinConversation('c2');
    expect(joins()).toEqual([{ conversationId: 'c2' }]);
  });

  it('★ counted: two holders, one join; the last to leave leaves, once', async () => {
    const transport = await connectNow();
    connectEvent();
    const a = transport.joinConversation('c1');
    const b = transport.joinConversation('c1');
    expect(joins()).toHaveLength(1);

    a();
    a(); // a leave is idempotent
    expect(leaves()).toEqual([]);
    b();
    expect(leaves()).toEqual([{ conversationId: 'c1' }]);

    // Gone from the set: a reconnect does not rejoin it.
    connectEvent();
    expect(joins()).toHaveLength(1);
  });
});

describe('★★ copilot.suggestions.updated - the bus sends `data`, with the tenant inside', () => {
  it('★★ translates the frame as the bridge emits it', () => {
    // `io.to(channel).emit(event.event, event.data)`; publishConvEvent puts tenantId in data.
    expect(
      translate('copilot.suggestions.updated', {
        tenantId: 't1',
        conversationId: 'c1',
        basedOnMessageId: 'm1',
        generatedAt: '2026-10-06T10:00:00Z',
        channel: 'conv:c1',
      }),
    ).toMatchObject({ type: 'copilot.suggestions.updated', tenantId: 't1', conversationId: 'c1' });
  });

  it('nothing without a conversation or a tenant', () => {
    expect(translate('copilot.suggestions.updated', { tenantId: 't1' })).toBeNull();
    expect(translate('copilot.suggestions.updated', { conversationId: 'c1' })).toBeNull();
  });
});
