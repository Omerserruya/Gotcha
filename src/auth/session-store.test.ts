/*
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetServerEnvCache } from '@/config/env.server';

/**
 * ★★ A render never spends the refresh token. With rotation, a refresh whose
 * new token cannot be written ends the session at the next one — the cause of
 * the hourly sign-out.
 */
const jar = vi.hoisted(() => ({ value: undefined as string | undefined, writable: false }));
const refreshSession = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('./refresh', () => ({ refreshSession }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: (_name: string, value: string) => {
      if (!jar.writable)
        throw new Error('Cookies can only be modified in a Server Action or Route Handler');
      jar.value = value;
    },
    delete: () => {
      if (!jar.writable) throw new Error('read-only');
      jar.value = undefined;
    },
  }),
}));

const { activeSession } = await import('./session-store');
const { sealSession, unsealSession } = await import('./session');

const expired = { sub: 's', sid: 'sid', at: 'at-old', rt: 'rt-old', exp: 1, abs: 2_000_000_000 };

beforeEach(async () => {
  process.env.SESSION_SECRET = 'x'.repeat(48);
  process.env.SESSION_COOKIE_NAME = 'gotcha_session';
  process.env.API_BASE_URL = 'http://localhost';
  process.env.APP_ORIGIN = 'https://dev.gotcha.co.il';
  process.env.OIDC_ISSUER = 'https://auth.example/application/o/gotcha/';
  process.env.OIDC_CLIENT_ID = 'gotcha-app';
  resetServerEnvCache();
  refreshSession.mockReset();
  jar.value = await sealSession(expired);
});
afterEach(() => {
  resetServerEnvCache();
});

describe('★★ activeSession refreshes only where the result can be kept', () => {
  it('in a render (no cookie writes): not refreshed, the token untouched, reported over', async () => {
    jar.writable = false;
    expect(await activeSession()).toBeNull();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('in a route handler or action: refreshed, and the new refresh token written', async () => {
    jar.writable = true;
    refreshSession.mockResolvedValue({ ...expired, at: 'at-new', rt: 'rt-new', exp: 9e9 });
    expect((await activeSession())?.at).toBe('at-new');
    expect((await unsealSession(jar.value))?.rt).toBe('rt-new');
  });

  it('a refused refresh where it can write: the cookie is cleared', async () => {
    jar.writable = true;
    refreshSession.mockResolvedValue(null);
    expect(await activeSession()).toBeNull();
    expect(jar.value).toBeUndefined();
  });
});
