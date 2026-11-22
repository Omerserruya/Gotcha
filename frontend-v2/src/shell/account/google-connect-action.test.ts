// @vitest-environment node
// jose seals with Node's Uint8Array; jsdom's TextEncoder hands it another realm's.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeSession = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('@/auth/session-store', () => ({ activeSession }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({
    APP_ORIGIN: 'https://dev.gotcha.co.il/v2',
    SESSION_SECRET: 'x'.repeat(32),
    SESSION_MAX_AGE_SECONDS: 28800,
    SESSION_COOKIE_NAME: 'gotcha_session',
  }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { beginGoogleConnect } = await import('./google-connect-action');
const { unsealConnectIntent } = await import('@/auth/google-sign-in');

beforeEach(() => {
  activeSession.mockReset();
  jar.set.mockReset();
});

describe('★★ beginGoogleConnect', () => {
  it('★★ seals the signed-in subject into its own short cookie, for the callback', async () => {
    activeSession.mockResolvedValue({ sub: 'ak-sub-1' });
    expect(await beginGoogleConnect()).toBe('ready');
    const [name, value, options] = jar.set.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe('gotcha_google_connect');
    expect(value).not.toContain('ak-sub-1');
    expect(await unsealConnectIntent(value)).toBe('ak-sub-1');
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
      secure: true,
    });
  });

  it('⚠⚠ signed out: nothing set', async () => {
    activeSession.mockResolvedValue(null);
    expect(await beginGoogleConnect()).toBe('failed');
    expect(jar.set).not.toHaveBeenCalled();
  });
});
