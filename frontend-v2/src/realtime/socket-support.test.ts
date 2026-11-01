import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SocketTransport } from './socket-transport';

/**
 * ★★ A socket opened in support mode outlives the session. When the platform
 * refuses its handshake because the session ended, it stops - no retry - and
 * says so, so the admin goes to the console as the HTTP path sends them.
 */
type Handler = (...args: unknown[]) => void;
const fake = vi.hoisted(() => {
  const state = { handlers: new Map<string, Handler>(), disconnected: 0 };
  const socket = {
    connected: false,
    on: (event: string, h: Handler) => state.handlers.set(event, h),
    onAny: () => undefined,
    emit: () => undefined,
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
});
