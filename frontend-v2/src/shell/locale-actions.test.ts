import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The person's own language write. The platform is mocked: nothing here
 * reaches it.
 */
const { put, signInIfSignedOut } = vi.hoisted(() => ({
  put: vi.fn(),
  signInIfSignedOut: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut }));

const { saveMyLanguage } = await import('./locale-actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
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

  it('⚠ a failure is not kept, and a signed-out session is offered to sign-in first', async () => {
    const cause = new ApiError({ kind: 'server', status: 500 });
    put.mockRejectedValueOnce(cause);
    expect(await saveMyLanguage('he')).toEqual({ ok: false });
    expect(signInIfSignedOut).toHaveBeenCalledWith(cause);
  });
});
