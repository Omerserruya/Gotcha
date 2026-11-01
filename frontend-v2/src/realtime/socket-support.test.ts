import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SocketTransport } from './socket-transport';

/**
 * ★★ A socket opened in support mode outlives the session. When the platform
 * says the session ended - the `support:ended` event, a refused room join or
 * a refused handshake - it stops, no retry, and says so once, so the admin
 * goes to the console as the HTTP path sends them.
 */
type Handler = (...args: unknown[]) => void;
const fake = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, Handler>(),
    disconnected: 0,
    acks: [] as Array<(answer: unknown) => void>,
  };
  const socket = {
    connected: false,
    on: (event: string, h: Handler) => state.handlers.set(event, h),
    onAny: () => undefined,
    emit: (_event: string, _body: unknown, ack?: (answer: unknown) => void) => {
      if (ack) state.acks.push(ack);
    },
    removeAllListeners: () => undefined,
    disconnect: () => {
      state.disconnected += 1;
    },
  };
  return { state, socket };
});
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

const open = async (onSupportEnded = vi.fn()) => {
  const transport = new SocketTransport({
    url: 'wss://x',
    tenantId: 't1',
    credentials: async () => ({ ticket: 'k' }),
    onSupportEnded,
  });
  transport.connect();
  await Promise.resolve();
  await Promise.resolve();
  return { transport, onSupportEnded };
};
const refuse = (message: string) => fake.state.handlers.get('connect_error')?.(new Error(message));

beforeEach(() => {
  fake.state.handlers.clear();
  fake.state.disconnected = 0;
  fake.state.acks = [];
  fake.socket.connected = false;
});

describe('the socket and support mode', () => {
  it.each(['support_expired', 'support_session_invalid'])(
    '★★ handshake refused %s: stopped, failed, and handed up',
    async (code) => {
      const { transport, onSupportEnded } = await open();
      refuse(code);
      expect(onSupportEnded).toHaveBeenCalledTimes(1);
      expect(fake.state.disconnected).toBe(1);
      expect(transport.state).toBe('failed');
    },
  );

  it('any other refusal is a fault to retry, as before', async () => {
    const { transport, onSupportEnded } = await open();
    refuse('xhr poll error');
    expect(onSupportEnded).not.toHaveBeenCalled();
    expect(fake.state.disconnected).toBe(0);
    expect(transport.state).toBe('reconnecting');
  });

  it('★★ ended while connected: the event stops it, and the server close that follows stays failed', async () => {
    const { transport, onSupportEnded } = await open();
    fake.state.handlers.get('connect')?.();
    fake.state.handlers.get('support:ended')?.({ code: 'support_expired' });
    fake.state.handlers.get('disconnect')?.('io server disconnect');
    expect(onSupportEnded).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('failed');
  });

  it('★ a room join refused support_expired ends it too, and the event after it is not a second end', async () => {
    const { transport, onSupportEnded } = await open();
    fake.socket.connected = true;
    transport.joinConversation('c1');
    fake.state.acks[0]?.({ ok: false, reason: 'support_expired' });
    fake.state.handlers.get('support:ended')?.({ code: 'support_expired' });
    expect(onSupportEnded).toHaveBeenCalledTimes(1);
    expect(fake.state.disconnected).toBe(1);
    expect(transport.state).toBe('failed');
  });

  it('★ the refused join alone is enough: the event may not come', async () => {
    const { transport, onSupportEnded } = await open();
    fake.socket.connected = true;
    transport.joinConversation('c1');
    fake.state.acks[0]?.({ ok: false, reason: 'support_expired' });
    expect(onSupportEnded).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('failed');
  });

  it('a join refused for another reason is only logged', async () => {
    const { transport, onSupportEnded } = await open();
    fake.socket.connected = true;
    transport.joinConversation('c1');
    fake.state.acks[0]?.({ ok: false, reason: 'not_found' });
    expect(onSupportEnded).not.toHaveBeenCalled();
    expect(fake.state.disconnected).toBe(0);
  });

  it('a plain server close is a reconnect, as before', async () => {
    const { transport, onSupportEnded } = await open();
    fake.state.handlers.get('connect')?.();
    fake.state.handlers.get('disconnect')?.('transport close');
    expect(onSupportEnded).not.toHaveBeenCalled();
    expect(transport.state).toBe('reconnecting');
  });
});
