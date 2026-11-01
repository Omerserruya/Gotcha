/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** ★★ A support session the platform ended is the console's page, never sign-in. */
const ended = vi.hoisted(() => ({ value: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => (name === 'x-gotcha-return-to' ? '/en/inbox' : null),
  }),
}));
vi.mock('@/support/support-ended', () => ({ supportEnded: () => ended.value }));

const { signInHere } = await import('./signed-out');

beforeEach(() => {
  ended.value = false;
});

describe('signInHere', () => {
  it('support mode ended: the route that clears it and opens the console', async () => {
    ended.value = true;
    expect(await signInHere()).toBe('/api/session/support-ended');
  });

  it('otherwise sign-in with the way back, as before', async () => {
    expect(await signInHere()).toBe('/api/auth/login?returnTo=%2Fen%2Finbox');
  });
});
