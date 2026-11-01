/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * ★★ Support mode on every server call: the route reaches the rule that
 * decides (console routes go out as the admin), and the session's workspace
 * wins over the sign-in's.
 */
const support = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/auth/session-store', () => ({ activeSession: async () => ({ at: 'at', tid: 't1' }) }));
vi.mock('@/support/support-headers', () => ({ supportHeaders: support }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ API_BASE_URL: 'http://api.test', API_TIMEOUT_MS: 5000 }),
}));

const { platformHeaders, serverApi } = await import('./server-api');
const { authEndpoints, consoleEndpoints } = await import('@/api/endpoints/registry');

beforeEach(() => {
  support.mockReset();
});

describe('platformHeaders in support mode', () => {
  it('the session and its workspace, over the sign-in tenant', async () => {
    support.mockResolvedValue({ 'x-support-session': 'ss1', 'x-tenant-id': 't9' });
    expect(await platformHeaders({ route: '/api/auth/me' })).toEqual({
      authorization: 'Bearer at',
      'x-tenant-id': 't9',
      'x-support-session': 'ss1',
      'accept-language': 'he',
    });
  });

  it('outside support mode: as before', async () => {
    support.mockResolvedValue({});
    expect(await platformHeaders()).toEqual({
      authorization: 'Bearer at',
      'x-tenant-id': 't1',
      'accept-language': 'he',
    });
  });

  it('★★ every serverApi call hands its route to the rule', async () => {
    support.mockResolvedValue({});
    const fetch = vi.fn(async () => Response.json({ data: null }));
    vi.stubGlobal('fetch', fetch);
    await serverApi().get({
      endpoint: consoleEndpoints.currentSupportSession(),
      payload: z.null(),
    });
    await serverApi().get({ endpoint: authEndpoints.me(), payload: z.null() });
    expect(support.mock.calls.map(([route]) => route)).toEqual([
      '/api/system/support-sessions/current',
      '/api/auth/me',
    ]);
  });
});
