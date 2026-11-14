/*
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★★ A sign-out ends the support session this browser holds - bounded, and
 * never at the sign-out's expense.
 */
const { post, held, warn } = vi.hoisted(() => ({
  post: vi.fn(),
  held: { value: null as { id: string; tenantId: string } | null },
  warn: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/support/support-cookie', () => ({ readSupport: async () => held.value }));
vi.mock('@/observability/logger', () => ({ logger: { warn, info: vi.fn() } }));

const { endSupportOnLogout } = await import('./end-on-logout');

beforeEach(() => {
  post.mockReset();
  warn.mockClear();
  held.value = { id: 'ss1', tenantId: 't9' };
});

describe('ending support mode on sign-out', () => {
  it('★★ a held session is ended, as the admin, within a bound', async () => {
    post.mockResolvedValue({});
    await endSupportOnLogout();
    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/support-sessions/ss1/end');
    expect(call.timeoutMs).toBe(3000);
  });

  it('none held: no call', async () => {
    held.value = null;
    await endSupportOnLogout();
    expect(post).not.toHaveBeenCalled();
    // Nothing held is not a failure: no warning on every ordinary sign-out.
    expect(warn).not.toHaveBeenCalled();
  });

  it('★ the platform failing never fails the sign-out', async () => {
    post.mockRejectedValue(new Error('down'));
    await expect(endSupportOnLogout()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('support.end_on_logout_failed', expect.anything());
  });
});
