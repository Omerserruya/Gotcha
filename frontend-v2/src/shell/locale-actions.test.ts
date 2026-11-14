import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The person's own language write. The platform is mocked: nothing here
 * reaches it.
 */
const { put, signInIfSignedOut, support } = vi.hoisted(() => ({
  put: vi.fn(),
  signInIfSignedOut: vi.fn(),
  support: { held: null as { id: string; tenantId: string } | null },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut }));
vi.mock('@/support/support-cookie', () => ({ readSupport: async () => support.held }));

const { saveMyLanguage } = await import('./locale-actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
  support.held = null;
  signInIfSignedOut.mockReset();
});

describe('★★ the interface language is kept on the person’s own account', () => {
  it('PUT /api/agents/me/locale {locale}', async () => {
    expect(await saveMyLanguage('he')).toEqual({ ok: true });
    expect(put).toHaveBeenCalledTimes(1);
    const [request] = put.mock.calls[0] as [{ endpoint: { path: string }; body: unknown }];
    expect(request.endpoint.path).toBe('/api/agents/me/locale');
    expect(request.body).toEqual({ locale: 'he' });
  });

  it("★★ in support mode nothing is written: it would be the support actor's language", async () => {
    support.held = { id: 'ss1', tenantId: 't9' };
    expect(await saveMyLanguage('he')).toEqual({ ok: true });
    expect(put).not.toHaveBeenCalled();
  });

  it('⚠ a failure is not kept, and a signed-out session is offered to sign-in first', async () => {
    const cause = new ApiError({ kind: 'server', status: 500 });
    put.mockRejectedValueOnce(cause);
    expect(await saveMyLanguage('he')).toEqual({ ok: false });
    expect(signInIfSignedOut).toHaveBeenCalledWith(cause);
  });
});
