import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The ticket the socket asks for comes from THIS app's route, on a path the
 * gateway gives this app at the root (`/api/session/ticket`). The platform's
 * own `/api/realtime/ticket` belongs to the auth service; the browser asking
 * there would get the platform's answer, or this app calling itself.
 */
const { made } = vi.hoisted(() => ({
  made: [] as { credentials: () => Promise<unknown> }[],
}));
vi.mock('@/config/env.client', () => ({
  clientEnv: { REALTIME_URL: 'https://realtime.test' },
}));
vi.mock('./socket-transport', () => ({
  SocketTransport: class {
    constructor(options: { credentials: () => Promise<unknown> }) {
      made.push(options);
    }
    connect() {}
    disconnect() {}
  },
}));

const { RealtimeProvider } = await import('./realtime-provider');

afterEach(() => {
  made.length = 0;
  vi.unstubAllGlobals();
});

describe('★★ the socket ticket comes from this app at the root', () => {
  it('POST /api/session/ticket, same-origin; the ticket goes to the handshake with the tenant', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ticket: 'k1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    render(
      <RealtimeProvider tenantId="t1">
        <span />
      </RealtimeProvider>,
    );
    expect(made).toHaveLength(1);
    await expect(made[0]!.credentials()).resolves.toEqual({ ticket: 'k1', tenantId: 't1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/ticket');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });
});
