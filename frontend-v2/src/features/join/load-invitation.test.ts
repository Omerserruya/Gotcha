import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* GET /api/public/onboarding/invite/:token (onboarding.ts:2989). Mocked. */
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { loadInvitation } from './load-invitation';

beforeEach(() => {
  api.get.mockReset();
});

describe('★★ what /join can show', () => {
  it('no token: missing - and nothing is asked', async () => {
    expect(await loadInvitation(undefined)).toEqual({ state: 'missing' });
    expect(await loadInvitation('')).toEqual({ state: 'missing' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('asks for the token it was given, encoded', async () => {
    api.get.mockResolvedValue({ tenant: { name: 'Aviv' }, email: null });
    await loadInvitation('a/b');
    expect(api.get.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/public/onboarding/invite/a%2Fb' },
    });
  });

  it('valid: the invitation', async () => {
    api.get.mockResolvedValue({ tenant: { name: 'Aviv' }, email: 'dana@aviv.co' });
    expect(await loadInvitation('tok')).toEqual({
      state: 'valid',
      invitation: { tenant: { name: 'Aviv' }, email: 'dana@aviv.co' },
    });
  });

  it('★ 404 is invalid (used, expired or unknown)', async () => {
    api.get.mockRejectedValue(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await loadInvitation('tok')).toEqual({ state: 'invalid' });
  });

  it('⚠⚠ anything else is unreachable, never "invalid" - the link may be fine', async () => {
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await loadInvitation('tok')).toEqual({ state: 'unreachable' });
    api.get.mockRejectedValueOnce(new ApiError({ kind: 'timeout' }));
    expect(await loadInvitation('tok')).toEqual({ state: 'unreachable' });
  });
});
