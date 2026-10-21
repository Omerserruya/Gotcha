import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* POST /api/auth/setup/resend (services/auth setup-link.ts:176). Mocked - no mail is sent. */
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { resendSetupLink } from './actions';

beforeEach(() => {
  api.post.mockReset();
});

describe('★★ asking for a new setup link', () => {
  it('sends the dead token - the only identification there is', async () => {
    api.post.mockResolvedValue({ ok: true });
    expect(await resendSetupLink('dead-1')).toEqual({ ok: true });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/auth/setup/resend' },
      body: { token: 'dead-1' },
    });
  });

  it('★ any 200 is "asked": the route answers the same whatever happened', async () => {
    api.post.mockResolvedValue({});
    expect(await resendSetupLink('t')).toEqual({ ok: true });
  });

  it('⚠ a 429 is its own reason - "try again" is the wrong advice for a while', async () => {
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'rate_limited', status: 429 }));
    expect(await resendSetupLink('t')).toEqual({ ok: false, reason: 'rate_limited' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await resendSetupLink('t')).toEqual({ ok: false, reason: 'failed' });
  });
});
