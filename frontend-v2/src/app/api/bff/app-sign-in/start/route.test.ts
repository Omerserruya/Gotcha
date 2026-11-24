// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({ APP_ORIGIN: 'https://app.gotcha.co.il', SESSION_SECRET: 'x'.repeat(32) }),
}));

const { GET } = await import('./route');
const { APP_HANDOFF_COOKIE, unsealHandoffStart } = await import('@/auth/app-handoff');

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const start = (query: string) =>
  GET(new NextRequest(`https://app.gotcha.co.il/api/bff/app-sign-in/start?${query}`));

describe('★★ the app’s Google sign-in starts here (2026-11-24)', () => {
  it('★★ on to our own sign-in with ?google=start, in the asked language', async () => {
    const response = await start(`challenge=${CHALLENGE}&locale=en`);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.gotcha.co.il/en/sign-in?google=start',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('★ Hebrew when the language is missing or unknown', async () => {
    const response = await start(`challenge=${CHALLENGE}&locale=xx`);
    expect(response.headers.get('location')).toBe(
      'https://app.gotcha.co.il/he/sign-in?google=start',
    );
  });

  it('★★ seals the challenge for the callback, where the callback reads it', async () => {
    const response = await start(`challenge=${CHALLENGE}`);
    const cookie = response.cookies.get(APP_HANDOFF_COOKIE);
    expect(cookie?.path).toBe('/api/auth');
    expect(cookie?.httpOnly).toBe(true);
    expect(await unsealHandoffStart(cookie?.value)).toBe(CHALLENGE);
  });

  it('★★ ends any Authentik session in that browser: at the apex AND on this host', async () => {
    const response = await start(`challenge=${CHALLENGE}`);
    const lines = response.headers
      .getSetCookie()
      .filter((line) => line.startsWith('authentik_session='));
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => /Max-Age=0/.test(line) && /Path=\//.test(line))).toBe(true);
    expect(lines.filter((line) => /Domain=gotcha\.co\.il/.test(line))).toHaveLength(1);
  });

  it.each([[''], ['challenge=short'], ['challenge=' + 'a'.repeat(44)]])(
    '⚠⚠ no usable challenge (%s): refused, nothing set, nobody signed out',
    async (query) => {
      const response = await start(query);
      expect(response.status).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
});
