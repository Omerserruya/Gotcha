import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Mocked: nothing is sent, no email goes anywhere. */
const { api, log } = vi.hoisted(() => ({ api: { post: vi.fn() }, log: { warn: vi.fn() } }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
vi.mock('@/observability/logger', () => ({ logger: log }));

import { confirmAccountDeletion, requestAccountDeletion } from './actions';

beforeEach(() => {
  api.post.mockReset();
  log.warn.mockReset();
});

describe('★★ request, at the wire', () => {
  it('★★ the auth route; the address trimmed and lower-cased; an empty workspace is null', async () => {
    api.post.mockResolvedValue({ data: { accepted: true } });
    expect(
      await requestAccountDeletion({ email: ' Dana@Aviv.co.il ', workspace: '  ', locale: 'he' }),
    ).toEqual({ ok: true });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/auth/account-deletion/request' },
      body: { email: 'dana@aviv.co.il', workspace: null, locale: 'he' },
    });
  });

  it('★ the workspace as typed, cut at 120; an unknown locale is en', async () => {
    api.post.mockResolvedValue({ data: { accepted: true } });
    await requestAccountDeletion({
      email: 'a@b.co',
      workspace: ` ${'w'.repeat(200)} `,
      locale: 'fr',
    });
    expect(api.post.mock.calls[0]![0].body).toEqual({
      email: 'a@b.co',
      workspace: 'w'.repeat(120),
      locale: 'en',
    });
  });

  it('★ not an address: refused here, before any call', async () => {
    expect(await requestAccountDeletion({ email: 'dana', workspace: '', locale: 'en' })).toEqual({
      ok: false,
      reason: 'BAD_EMAIL',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('★ BAD_EMAIL and RATE_LIMITED as the route names them; a bare 429 is RATE_LIMITED too', async () => {
    const send = () => requestAccountDeletion({ email: 'a@b.co', workspace: '', locale: 'en' });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, developerMessage: 'BAD_EMAIL' }),
    );
    expect(await send()).toEqual({ ok: false, reason: 'BAD_EMAIL' });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'rate_limited', status: 429, developerMessage: 'RATE_LIMITED' }),
    );
    expect(await send()).toEqual({ ok: false, reason: 'RATE_LIMITED' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'rate_limited', status: 429 }));
    expect(await send()).toEqual({ ok: false, reason: 'RATE_LIMITED' });
    api.post.mockRejectedValueOnce(new Error('boom'));
    expect(await send()).toEqual({ ok: false, reason: 'failed' });
  });

  it('★★ nothing logged names the address or the workspace', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await requestAccountDeletion({
      email: 'secret@aviv.co.il',
      workspace: 'Aviv Ltd',
      locale: 'en',
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret@aviv|Aviv Ltd/);
  });
});

describe('★★ confirm, at the wire', () => {
  it('★★ the auth route, the token as given; the confirmation as read', async () => {
    api.post.mockResolvedValue({
      data: { status: 'scheduled', deleteBy: '2026-12-14T10:00:00Z', email: 'd***@a.co.il' },
    });
    expect(await confirmAccountDeletion(' tok-1 ')).toEqual({
      ok: true,
      confirmed: { status: 'scheduled', deleteBy: '2026-12-14T10:00:00Z', email: 'd***@a.co.il' },
    });
    expect(api.post.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/auth/account-deletion/confirm' },
      body: { token: 'tok-1' },
    });
  });

  it('no token: refused here, no call', async () => {
    expect(await confirmAccountDeletion('  ')).toEqual({ ok: false, reason: 'BAD_TOKEN' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError({ kind: 'validation', status: 400, developerMessage: 'BAD_TOKEN' }), 'BAD_TOKEN'],
    [
      new ApiError({ kind: 'not_found', status: 410, developerMessage: 'TOKEN_EXPIRED' }),
      'TOKEN_EXPIRED',
    ],
    [
      new ApiError({ kind: 'conflict', status: 409, developerMessage: 'ALREADY_CONFIRMED' }),
      'ALREADY_CONFIRMED',
    ],
    [new ApiError({ kind: 'not_found', status: 410 }), 'TOKEN_EXPIRED'],
    [new ApiError({ kind: 'conflict', status: 409 }), 'ALREADY_CONFIRMED'],
    [new ApiError({ kind: 'server', status: 500, developerMessage: 'X' }), 'failed'],
  ])('★ %s → %s', async (cause, reason) => {
    api.post.mockRejectedValue(cause);
    expect(await confirmAccountDeletion('t')).toEqual({ ok: false, reason });
  });

  it('★★ nothing logged names the token', async () => {
    api.post.mockRejectedValue(new Error('boom'));
    await confirmAccountDeletion('tok-secret-123');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('tok-secret-123');
  });
});
