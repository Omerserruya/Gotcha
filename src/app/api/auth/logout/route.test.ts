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
