import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * ★★ A 401 is "sign in again", never a screen of "couldn't read" (Omer,
 * 2026-10-04). The layout's own read uses the token every page read uses, and
 * every page waits behind it.
 */
const activeSession = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
);
vi.mock('server-only', () => ({}));
vi.mock('@/auth/session-store', () => ({ activeSession }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': '/en/approvals?tab=done' }),
}));
vi.mock('@/i18n/load-messages', () => ({ loadMessages: async () => ({}) }));
vi.mock('@/shell/AppProviders', () => ({ AppProviders: () => null }));
vi.mock('@/shell/AppShell', () => ({ AppShell: () => null }));

const { default: Layout } = await import('./layout');
const render = () => Layout({ children: null, params: Promise.resolve({ locale: 'en' }) });
const SIGN_IN = `REDIRECT /api/auth/login?returnTo=${encodeURIComponent('/en/approvals?tab=done')}`;

beforeEach(() => {
  activeSession.mockReset();
  get.mockReset();
  redirect.mockClear();
  activeSession.mockResolvedValue({ sub: 's', sid: 'i', at: 'a', exp: 9e9, abs: 9e9 });
});

describe('★★ signed out is sign-in, with the way back', () => {
  it('no session (or one the render cannot renew): sign-in, returning here', async () => {
    activeSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(SIGN_IN);
  });

  it('★★ the platform refuses the token (401): sign-in — no partial screen', async () => {
    get.mockRejectedValue(new ApiError({ kind: 'authentication', status: 401 }));
    await expect(render()).rejects.toThrow(SIGN_IN);
  });

  it.each([
    [403, 'authorization'],
    [503, 'server'],
  ] as const)(
    'a %i is not signed out: the screen renders, its read marked unavailable',
    async (status, kind) => {
      get.mockRejectedValue(new ApiError({ kind, status }));
      await expect(render()).resolves.toBeTruthy();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
