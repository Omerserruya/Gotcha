import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * POST /api/public/onboarding/invite/accept (services/auth onboarding.ts:3023),
 * at the wire. Mocked - no request is made, nobody joins anything.
 */
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { acceptInvite } from './actions';

const refuse = (status: number, error: string) =>
  api.post.mockRejectedValueOnce(
    new ApiError({
      kind: status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'validation',
      status,
      developerMessage: error,
    }),
  );

beforeEach(() => {
  api.post.mockReset();
});

describe('★★ accepting an invitation', () => {
  it('sends the token and the trimmed name; an open link sends the address, lower-cased', async () => {
    api.post.mockResolvedValue({ setupLink: null });
    await acceptInvite({ token: 'tok', name: '  Dana Levi ', email: ' Dana@AvivCo.il ' });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/public/onboarding/invite/accept' },
      body: { token: 'tok', name: 'Dana Levi', email: 'dana@avivco.il' },
    });
  });

  it('a fixed-address invitation sends no address at all', async () => {
    api.post.mockResolvedValue({ setupLink: null });
    await acceptInvite({ token: 'tok', name: 'Dana' });
    expect((api.post.mock.calls[0]![0] as { body: object }).body).not.toHaveProperty('email');
  });

  it('★ answers with the setup link, or null when the person already has a password', async () => {
    api.post.mockResolvedValueOnce({ setupLink: 'https://app.gotcha.co.il/api/auth/setup/abc' });
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({
      ok: true,
      setupLink: 'https://app.gotcha.co.il/api/auth/setup/abc',
    });
    api.post.mockResolvedValueOnce({ setupLink: null });
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({ ok: true, setupLink: null });
  });

  it('⚠ a link that is not a web address is never handed to the browser', async () => {
    for (const bad of ['javascript:alert(1)', '/relative/path', 'not a url']) {
      api.post.mockResolvedValueOnce({ setupLink: bad });
      expect(await acceptInvite({ token: 't', name: 'D' }), bad).toEqual({
        ok: true,
        setupLink: null,
      });
    }
  });

  it('★ every refusal the route names is its own reason', async () => {
    refuse(404, 'invite_invalid_or_expired');
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({ ok: false, reason: 'invalid' });
    // Backend b0ed4d81: the same 404 says why.
    for (const reason of ['used', 'expired'] as const) {
      api.post.mockRejectedValueOnce(
        new ApiError({
          kind: 'not_found',
          status: 404,
          developerMessage: 'invite_invalid_or_expired',
          reason,
        }),
      );
      expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({ ok: false, reason });
    }
    refuse(400, 'email_required');
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({
      ok: false,
      reason: 'email_required',
    });
    refuse(409, 'email_already_in_tenant');
    expect(await acceptInvite({ token: 't', name: 'D', email: 'a@b.co' })).toEqual({
      ok: false,
      reason: 'already_member',
    });
    // The shared `validate` middleware's 400.
    refuse(400, 'Validation failed');
    expect(await acceptInvite({ token: 't', name: 'D', email: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({ ok: false, reason: 'failed' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'network' }));
    expect(await acceptInvite({ token: 't', name: 'D' })).toEqual({ ok: false, reason: 'failed' });
  });
});
