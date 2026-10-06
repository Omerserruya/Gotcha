/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from './session';

/**
 * A fake identity provider that rotates the way Authentik is configured to
 * (`refresh_token_threshold = 0`): every refresh issues a new refresh token
 * and the one just spent dies.
 */
const idp = vi.hoisted(() => {
  const live = new Set<string>(['rt-1']);
  let issued = 1;
  const grant = vi.fn(async (_config: unknown, rt: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!live.has(rt)) throw new Error('invalid_grant: refresh token was spent');
    live.delete(rt);
    issued += 1;
    live.add(`rt-${issued}`);
    return { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 1800 };
  });
  return {
    grant,
    reset: () => {
      live.clear();
      live.add('rt-1');
      issued = 1;
    },
  };
});
vi.mock('server-only', () => ({}));
vi.mock('./oidc', () => ({
  oidcConfiguration: async () => ({}),
  refreshTokenGrant: idp.grant,
}));

const { refreshSession } = await import('./refresh');

const session = (rt: string): Session => ({
  sub: 's',
  sid: 'sid',
  at: 'at-old',
  rt,
  exp: 1,
  abs: 2_000_000_000,
});

beforeEach(() => {
  idp.reset();
  idp.grant.mockClear();
});

describe('★★ rotation - the session lives past the first refresh', () => {
  it('two refreshes in a row: each spends the token the last one issued, and both succeed', async () => {
    const first = await refreshSession(session('rt-1'));
    expect(first?.rt).toBe('rt-2');
    expect(first?.at).toBe('at-2');
    const second = await refreshSession(first!);
    expect(second?.rt).toBe('rt-3');
    expect(second?.exp).toBeGreaterThan(Date.now() / 1000 + 1700);
  });

  it('★ the failure that signed people out: refreshing with the SPENT token is refused', async () => {
    await refreshSession(session('rt-1'));
    // What a render left in the cookie when it could not write the new one.
    expect(await refreshSession(session('rt-1'))).toBeNull();
  });

  it('six reads at once spend the token once', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, () => refreshSession(session('rt-1'))));
    expect(idp.grant).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((s) => s?.rt))).toEqual(new Set(['rt-2']));
  });
});
