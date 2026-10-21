import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/*
 * POST /api/account/email-change/verify (services/auth account.ts:448), at
 * the wire. Mocked - no address changes.
 */
const api = vi.hoisted(() => ({ post: vi.fn() }));
const signInIfSignedOut = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

import { verifyEmailChange } from './verify-email-action';

const refuse = (status: number, error: string) =>
  api.post.mockRejectedValueOnce(
    new ApiError({ kind: 'validation', status, developerMessage: error }),
  );

beforeEach(() => {
  api.post.mockReset();
  signInIfSignedOut.mockClear();
});

describe('★★ confirming a new sign-in address', () => {
  it('sends the token in the body, and answers with the new address', async () => {
    api.post.mockResolvedValue({ email: 'new@aviv.co' });
    expect(await verifyEmailChange('t.sig')).toEqual({ ok: true, email: 'new@aviv.co' });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/account/email-change/verify' },
      body: { token: 't.sig' },
    });
  });

  it('★ each refusal the route names is its own reason', async () => {
    refuse(400, 'invalid_or_expired');
    expect(await verifyEmailChange('t')).toEqual({ ok: false, reason: 'invalid' });
    refuse(403, 'wrong_account');
    expect(await verifyEmailChange('t')).toEqual({ ok: false, reason: 'wrong_account' });
    refuse(409, 'email_taken');
    expect(await verifyEmailChange('t')).toEqual({ ok: false, reason: 'taken' });
    refuse(502, 'idp_sync_failed');
    expect(await verifyEmailChange('t')).toEqual({ ok: false, reason: 'unfinished' });
    refuse(404, 'not_found');
    expect(await verifyEmailChange('t')).toEqual({ ok: false, reason: 'failed' });
  });

  it('⚠ a 401 goes to sign-in first, with the cause', async () => {
    const signedOut = new ApiError({ kind: 'authentication', status: 401 });
    api.post.mockRejectedValueOnce(signedOut);
    await verifyEmailChange('t');
    expect(signInIfSignedOut).toHaveBeenCalledWith(signedOut);
  });
});
