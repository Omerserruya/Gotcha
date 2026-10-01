/*
 * @vitest-environment node
 *
 * ⚠ Sealing runs on Node's WebCrypto. Under jsdom, `TextEncoder` yields a
 *   Uint8Array from another realm and jose's own `instanceof` check rejects
 *   it — a jsdom artifact, not a real failure.
 *
 * ★ This is recorded verbatim at the top of `session.test.ts`, and I wrote
 *   this file without reading its sibling. The answer was already in the
 *   directory.
 */
import { describe, expect, it, vi } from 'vitest';

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: vi.fn(() => ({
    APP_ORIGIN: 'https://dev.gotcha.co.il/v2',
    SESSION_SECRET: 'x'.repeat(48),
    SESSION_COOKIE_NAME: 'gotcha_session',
    SESSION_MAX_AGE_SECONDS: 28800,
  })),
}));
vi.mock('@/config/env.server', () => ({ serverEnv }));

const { sealIdToken, unsealIdToken, idTokenCookieOptions, ID_TOKEN_COOKIE, MAX_COOKIE_BYTES } =
  await import('./session');

/**
 * The id token, in a cookie of its own.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE 4 KB LIMIT IS PER COOKIE, NOT PER DOMAIN
 * ════════════════════════════════════════════════════════════════════════════
 * `sessionSchema` recorded that the id token is "deliberately NOT kept here —
 * see MAX_COOKIE_BYTES". That was true of the SESSION cookie and the
 * conclusion drawn from it — that we could not keep one at all — does not
 * follow. A second cookie has its own ceiling.
 *
 * The cost of not having it: RP-initiated logout can only offer `client_id`,
 * which says which application is asking but not who, so the provider asks the
 * person to confirm — on its own page, in its own vocabulary, with a button
 * reading "Log out of GOTCHA" on a screen reached by logging out.
 */
describe('⚠⚠ the id token survives a round trip and nothing else does', () => {
  it('★★ seals and unseals exactly what it was given', async () => {
    const token = `header.${'p'.repeat(600)}.signature`;
    expect(await unsealIdToken(await sealIdToken(token))).toBe(token);
  });

  it('⚠⚠ fits a realistic token inside one cookie, with room', async () => {
    /*
     * ★ The number that was the open question. An Authentik id token is a
     *   signed JWT of roughly 800–1,300 characters; this is a generous one.
     *   Measured here rather than assumed, because "almost certainly fits" is
     *   the kind of claim today has punished.
     */
    const token = `${'h'.repeat(40)}.${'p'.repeat(1200)}.${'s'.repeat(350)}`;
    const sealed = await sealIdToken(token);
    const cookieBytes = ID_TOKEN_COOKIE.length + 1 + sealed.length;

    expect(cookieBytes).toBeLessThan(MAX_COOKIE_BYTES);
    // And it is not fitting by a hair.
    expect(MAX_COOKIE_BYTES - cookieBytes).toBeGreaterThan(500);
  });

  it('⚠⚠ THROWS rather than truncating when it will not fit', async () => {
    /*
     * A truncated `id_token_hint` is worse than an absent one: the provider
     * cannot verify it and its behaviour on a malformed hint is unspecified.
     * The caller omits the cookie and falls back to `client_id` — a
     * confirmation screen, which is a cost, where a broken hint risks a
     * sign-out that does not sign out.
     */
    await expect(sealIdToken('z'.repeat(6000))).rejects.toThrow(/bytes/);
  });

  it('⚠ treats a tampered or unreadable value as absent, never as an error', async () => {
    for (const bad of [undefined, '', 'not-a-jwe', 'a.b.c.d.e']) {
      expect(await unsealIdToken(bad), String(bad)).toBeNull();
    }
  });

  it('⚠⚠ is scoped to the logout path, so it costs nothing on any other request', async () => {
    /*
     * ★ The reason it can exist at all. The session cookie is already 2.6 KB
     *   on every request; a second one at `/` would add its weight to all of
     *   them. `gotcha_login` uses the same technique at `/api/auth`.
     */
    const options = idTokenCookieOptions();
    expect(options.path).toMatch(/\/api\/auth\/logout$/);
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('⚠ and is not secure on a plain-http origin, or it is never set at all', async () => {
    // Local development runs on http; a `secure` cookie there is silently
    // dropped, which would make this untestable by hand.
    serverEnv.mockReturnValueOnce({
      APP_ORIGIN: 'http://localhost:3000',
      SESSION_SECRET: 'x'.repeat(48),
      SESSION_COOKIE_NAME: 'gotcha_session',
      SESSION_MAX_AGE_SECONDS: 28800,
    });
    expect(idTokenCookieOptions().secure).toBe(false);
  });
});
