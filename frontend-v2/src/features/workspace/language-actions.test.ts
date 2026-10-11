import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/**
 * The two language writes. The platform is mocked: nothing here reaches it.
 */
const put = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { saveMyLanguage, saveSystemLanguage } = await import('./actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
});

describe('★★ the languages inside GOTCHA are written where the platform keeps them', () => {
  it('the workspace’s system language: PUT /api/agents/settings/locale {locale}', async () => {
    expect(await saveSystemLanguage('he')).toEqual({ ok: true });
    const [request] = put.mock.calls[0] as [{ endpoint: { path: string }; body: unknown }];
    expect(request.endpoint.path).toBe('/api/agents/settings/locale');
    expect(request.body).toEqual({ locale: 'he' });
  });

  it('this person’s interface language: PUT /api/agents/me/locale {locale}', async () => {
    expect(await saveMyLanguage('en')).toEqual({ ok: true });
    const [request] = put.mock.calls[0] as [{ endpoint: { path: string }; body: unknown }];
    expect(request.endpoint.path).toBe('/api/agents/me/locale');
    expect(request.body).toEqual({ locale: 'en' });
  });

  it('⚠ a 403 is "forbidden" (said in words); anything else is "failed"', async () => {
    put.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await saveSystemLanguage('he')).toEqual({ ok: false, reason: 'forbidden' });
    put.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveSystemLanguage('he')).toEqual({ ok: false, reason: 'failed' });
  });
});
