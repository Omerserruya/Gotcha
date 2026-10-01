import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ID_TOKEN_COOKIE } from '@/auth/session';

/**
 * Signing out, and where the person ends up.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE BASELINE: THE WALK ENDED ON THE PROVIDER'S PAGE
 * ════════════════════════════════════════════════════════════════════════════
 * Measured: `end-session` with `client_id` and no hint answers a confirmation
 * screen, and `post_logout_redirect_uri` is NEVER FOLLOWED because the screen
 * is waiting for a click. So sign-out does not pass through the provider's
 * page — it terminates there, offering "Go back to overview · Log out of
 * GOTCHA · Log back into GOTCHA".
 *
 * ★ One of those buttons says "Log out of GOTCHA" on a screen reached BY
 *   logging out. A person who does not press it may reasonably believe they
 *   are still signed in. The ambiguity is the defect, more than the styling.
 */
const buildEndSessionUrl = vi.hoisted(() => vi.fn());
const unsealIdToken = vi.hoisted(() => vi.fn());
const readSession = vi.hoisted(() => vi.fn());

vi.mock('@/auth/oidc', () => ({
  buildEndSessionUrl,
  oidcConfiguration: async () => ({}),
}));
vi.mock('@/auth/session-store', () => ({ readSession }));
vi.mock('@/auth/session', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, unsealIdToken };
});
vi.mock('@/api/client/csrf', () => ({ assertSameOrigin: () => null }));

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: vi.fn(() => ({
    APP_ORIGIN: 'https://dev.gotcha.co.il/v2',
    OIDC_CLIENT_ID: 'gotcha-app',
    SESSION_COOKIE_NAME: 'gotcha_session',
    SESSION_MAX_AGE_SECONDS: 28800,
  })),
}));
vi.mock('@/config/env.server', () => ({ serverEnv }));

const { POST } = await import('./route');

const post = async (withHint: boolean) => {
  const request = new NextRequest('https://dev.gotcha.co.il/v2/api/auth/logout', {
    method: 'POST',
  });
  if (withHint) request.cookies.set(ID_TOKEN_COOKIE, 'sealed-id-token');
  return POST(request);
};

beforeEach(() => {
  vi.clearAllMocks();
  readSession.mockResolvedValue({ sid: 's1', sub: 'u1' });
  unsealIdToken.mockResolvedValue(null);
  buildEndSessionUrl.mockReturnValue(
    new URL('https://auth-dev.gotcha.co.il/application/o/gotcha/end-session/'),
  );
});

describe('⚠⚠ the hint, which is what stops the provider asking', () => {
  it('★★ sends `id_token_hint` when the cookie is readable', async () => {
    unsealIdToken.mockResolvedValue('the.id.token');

    await post(true);
    const params = buildEndSessionUrl.mock.calls.at(-1)?.[1] as Record<string, unknown>;

    expect(params.id_token_hint).toBe('the.id.token');
    // `client_id` is not sent alongside: the hint supersedes it.
    expect(params.client_id).toBeUndefined();
  });

  it('⚠⚠ falls back to `client_id` when there is no readable hint', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE DANGEROUS CASE, AND IT MUST STAY SAFE
     * ════════════════════════════════════════════════════════════════════════
     * An older session, a cleared cookie, a rotated secret, a grant with no id
     * token. Every one must still reach the provider's end-session endpoint —
     * with the confirmation screen, which is a cost.
     *
     * ★ A sign-out that ASKS is far better than one that does not sign out. If
     *   this ever silently skipped the provider, we would have traded a
     *   confusing screen for a session that is still alive — the one outcome
     *   worse than what the reviewer photographed.
     */
    unsealIdToken.mockResolvedValue(null);

    await post(false);
    const params = buildEndSessionUrl.mock.calls.at(-1)?.[1] as Record<string, unknown>;

    expect(params.client_id).toBe('gotcha-app');
    expect(params.id_token_hint).toBeUndefined();
    // And it still goes to the provider rather than straight to sign-in.
    expect(buildEndSessionUrl).toHaveBeenCalled();
  });

  it('⚠⚠ carries `post_logout_redirect_uri` either way, or there is nowhere to land', async () => {
    for (const token of ['the.id.token', null]) {
      unsealIdToken.mockResolvedValue(token);
      await post(token !== null);
      const params = buildEndSessionUrl.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(params.post_logout_redirect_uri, String(token)).toMatch(/\/sign-in$/);
    }
  });
});

describe('⚠⚠ what the response clears', () => {
  it('★★ deletes the hint cookie as well as the session', async () => {
    /*
     * A sealed id token outliving the session it describes is a stale
     * credential in a browser for nothing — and on the next sign-out it would
     * be offered as a hint for a session that no longer exists.
     */
    const response = await post(true);
    const cleared = response.cookies.getAll().filter((cookie) => cookie.value === '');
    const names = cleared.map((cookie) => cookie.name);

    expect(names).toContain('gotcha_session');
    expect(names).toContain(ID_TOKEN_COOKIE);
  });

  it('⚠⚠ and clears it on the PATH IT WAS SET ON', async () => {
    /*
     * ★ A delete whose path does not match the setter is a SILENT NO-OP. The
     *   cookie survives the sign-out and every test asserting "delete was
     *   called" still passes — which is exactly the shape of defect this
     *   repository keeps finding.
     */
    const response = await post(true);
    const hint = response.cookies.getAll().find((cookie) => cookie.name === ID_TOKEN_COOKIE);
    expect(hint?.path).toMatch(/\/api\/auth\/logout$/);
  });
});

describe('⚠⚠ the property that broke: a session must reach the provider', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE SHIPPED BUG WAS NOT IN THE HINT LOGIC. IT WAS IN WHAT SURROUNDED IT.
   * ════════════════════════════════════════════════════════════════════════
   * Reading the hint sat INSIDE the try whose catch falls back to a local
   * redirect. That catch exists for one thing — a provider with no
   * `end_session_endpoint` — so anything else inside it silently turns a
   * sign-out into a redirect that signs nobody out.
   *
   * ★ Measured on the deployed build: `redirectTo` was our own `/v2/sign-in`,
   *   `end-session` was never called, and `authentik_session` SURVIVED. A
   *   fresh authorization then returned a code with no credentials entered.
   *
   * ⚠ The existing tests all passed. They asserted the PARAMETERS of the
   *   end-session call — which is a fact about the branch that builds it, and
   *   says nothing about whether that branch is reached. A local URL is a
   *   valid string and a passing shape.
   */
  it('⚠⚠ reaches the provider even when reading the hint explodes', async () => {
    /*
     * The exact shape of the regression. `unsealIdToken` throwing must cost a
     * confirmation screen, never the provider call.
     */
    unsealIdToken.mockRejectedValue(new Error('key rotated'));

    const response = await post(true);
    expect(buildEndSessionUrl).toHaveBeenCalled();

    const params = buildEndSessionUrl.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(params.client_id).toBe('gotcha-app');

    const body = (await response.json()) as { redirectTo: string };
    expect(new URL(body.redirectTo).origin).toBe('https://auth-dev.gotcha.co.il');
  });

  it('⚠⚠ and the answer is a PROVIDER url, not merely a url', async () => {
    /*
     * ★ Asserted on `redirectTo` itself rather than on the call's arguments.
     *   Every previous test here checked what we would pass IF we called —
     *   and the bug was that we did not call.
     */
    for (const token of ['the.id.token', null]) {
      unsealIdToken.mockResolvedValue(token);
      const response = await post(token !== null);
      const body = (await response.json()) as { redirectTo: string };

      expect(new URL(body.redirectTo).origin, String(token)).toBe('https://auth-dev.gotcha.co.il');
      expect(body.redirectTo, String(token)).not.toContain('dev.gotcha.co.il/v2/sign-in');
    }
  });

  it('★ only a provider with no end-session endpoint may land locally', async () => {
    /*
     * The one legitimate reason for a local redirect — and it is now logged,
     * because a sign-out that quietly stops calling the provider looks
     * exactly like one that worked: it lands on our sign-in page either way.
     */
    buildEndSessionUrl.mockImplementation(() => {
      throw new Error('no end_session_endpoint');
    });

    const response = await post(true);
    const body = (await response.json()) as { redirectTo: string };
    expect(body.redirectTo).toContain('/sign-in');
  });

  it('⚠ and with no session there is nothing to end, which is not the same thing', async () => {
    // A signed-out caller must not be sent to the provider to sign out again.
    readSession.mockResolvedValue(null);

    const response = await post(false);
    expect(buildEndSessionUrl).not.toHaveBeenCalled();
    const body = (await response.json()) as { redirectTo: string };
    expect(body.redirectTo).toContain('/sign-in');
  });
});

describe('⚠⚠ the sign-out goes via the origin that can run the flow', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════
   * THE FETCH MUST BE SAME-ORIGIN, SO THE BROWSER GOES THERE FIRST
   * ════════════════════════════════════════════════════════════════════════
   * The invalidation flow can be RUN rather than rendered — but only from the
   * provider's own origin, where `response.url` after the redirect chain is
   * readable. `signOut()` runs on the product, so a fetch from there is
   * opaque and the evidence is unavailable.
   */
  it('★★ wraps the end-session URL in the sign-in page when one is configured', async () => {
    vi.stubEnv('SIGN_IN_URL', 'https://auth-dev.gotcha.co.il/sign-in');
    unsealIdToken.mockResolvedValue('the.id.token');

    const response = await post(true);
    const { redirectTo } = (await response.json()) as { redirectTo: string };
    const url = new URL(redirectTo);

    expect(url.origin).toBe('https://auth-dev.gotcha.co.il');
    expect(url.pathname).toBe('/sign-in');

    // And the end-session URL survives intact inside it, hint and all.
    const carried = new URL(url.searchParams.get('signOut') ?? '');
    expect(carried.pathname).toContain('end-session');
    vi.unstubAllEnvs();
  });

  it('⚠⚠ and is UNCHANGED without one — a single origin has nothing to borrow', async () => {
    vi.unstubAllEnvs();
    unsealIdToken.mockResolvedValue('the.id.token');

    const response = await post(true);
    const { redirectTo } = (await response.json()) as { redirectTo: string };

    expect(new URL(redirectTo).origin).toBe('https://auth-dev.gotcha.co.il');
    expect(redirectTo).toContain('end-session');
    expect(new URL(redirectTo).searchParams.has('signOut')).toBe(false);
  });

  it('⚠⚠ a misconfigured SIGN_IN_URL costs the wrapping, never the sign-out', async () => {
    /*
     * ★ The failure that must not happen here. If this threw, the catch above
     *   it would fall back to a LOCAL redirect — which is `82e0a2c` again: a
     *   clean screen and a living session.
     */
    vi.stubEnv('SIGN_IN_URL', 'not a url');
    unsealIdToken.mockResolvedValue('the.id.token');

    const response = await post(true);
    const { redirectTo } = (await response.json()) as { redirectTo: string };

    expect(new URL(redirectTo).origin).toBe('https://auth-dev.gotcha.co.il');
    expect(redirectTo).toContain('end-session');
    vi.unstubAllEnvs();
  });
});
