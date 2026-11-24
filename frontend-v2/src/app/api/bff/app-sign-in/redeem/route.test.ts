// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/config/env.server', () => ({
  serverEnv: () => ({
    APP_ORIGIN: 'https://app.gotcha.co.il',
    SESSION_SECRET: 'x'.repeat(32),
    SESSION_MAX_AGE_SECONDS: 28800,
    SESSION_COOKIE_NAME: 'gotcha_session',
  }),
}));

const { POST } = await import('./route');
const { s256, sealHandoffCode } = await import('@/auth/app-handoff');
const { sessionCookieOptions, idTokenCookieOptions } = await import('@/auth/session');
const { TERMS_PENDING_COOKIE } = await import('@/auth/google-sign-in');

const VERIFIER = 'v'.repeat(43);
const redeem = (body: unknown, origin = 'https://app.gotcha.co.il') =>
  POST(
    new NextRequest('https://app.gotcha.co.il/api/bff/app-sign-in/redeem', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('★★ the WebView trades the code for the session (2026-11-24)', () => {
  it('★★ the right verifier: the callback’s three cookies, in this jar', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), { s: 'S', i: 'I', t: true });
    const response = await redeem({ code, verifier: VERIFIER });
    expect(response.status).toBe(200);
    expect(response.cookies.get(sessionCookieOptions().name)?.value).toBe('S');
    expect(response.cookies.get(idTokenCookieOptions().name)?.value).toBe('I');
    expect(response.cookies.get(TERMS_PENDING_COOKIE)?.value).toBe('1');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('★ no Terms owed: an old marker is cleared; no ID token: none set', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), { s: 'S', i: null, t: false });
    const response = await redeem({ code, verifier: VERIFIER });
    expect(response.cookies.get(idTokenCookieOptions().name)).toBeUndefined();
    expect(response.cookies.get(TERMS_PENDING_COOKIE)?.value).toBe('');
  });

  it('⚠⚠ another verifier: refused, and no cookie', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), { s: 'S', i: 'I', t: false });
    const response = await redeem({ code, verifier: 'w'.repeat(43) });
    expect(response.status).toBe(400);
    expect(response.cookies.get(sessionCookieOptions().name)).toBeUndefined();
  });

  it('⚠⚠ from another origin: refused before the code is read', async () => {
    const code = await sealHandoffCode(await s256(VERIFIER), { s: 'S', i: 'I', t: false });
    const response = await redeem({ code, verifier: VERIFIER }, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(response.cookies.get(sessionCookieOptions().name)).toBeUndefined();
  });

  it('⚠ a body that is not the shape: refused', async () => {
    expect((await redeem({ nope: 1 })).status).toBe(400);
  });
});
