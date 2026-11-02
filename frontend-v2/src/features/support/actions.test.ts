import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Support mode at the wire. ⚠ Mocked: nothing is sent. */
const { api, signIn, warn, cookie } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  signIn: vi.fn(async () => {}),
  warn: vi.fn(),
  cookie: {
    held: null as { id: string; tenantId: string } | null,
    write: vi.fn(async () => true),
    clear: vi.fn(async () => {}),
  },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: signIn }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));
vi.mock('@/support/support-cookie', () => ({
  readSupport: async () => cookie.held,
  writeSupport: cookie.write,
  clearSupport: cookie.clear,
}));

import { endSupport, resumeSupport, startSupport } from './actions';

const SESSION = {
  id: 'ss1',
  tenantId: 't9',
  tenantName: 'Aviv & Co.',
  reason: 'ticket 42',
  startedAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-11-01T14:00:00.000Z',
};
const refused = (status: number, code: string, kind: ApiError['kind'] = 'authorization') =>
  new ApiError({ kind, status, code });

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  signIn.mockClear();
  warn.mockClear();
  cookie.held = null;
  cookie.write.mockReset();
  cookie.write.mockResolvedValue(true);
  cookie.clear.mockClear();
});

describe('★★ entering support mode', () => {
  it('★★ POST the workspace and the TRIMMED reason; the session is kept in this browser', async () => {
    api.post.mockResolvedValue(SESSION);
    expect(await startSupport('t9', '  ticket 42  ')).toEqual({ ok: true, session: SESSION });
    const call = api.post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/system/support-sessions');
    expect(call.body).toEqual({ tenantId: 't9', reason: 'ticket 42' });
    expect(cookie.write).toHaveBeenCalledWith(SESSION);
  });

  it('started but not kept: said, never "entered"', async () => {
    api.post.mockResolvedValue(SESSION);
    cookie.write.mockResolvedValue(false);
    expect(await startSupport('t9', 'r')).toEqual({ ok: false, reason: 'not_kept' });
  });

  it.each([
    [refused(403, 'not_system_admin'), 'forbidden'],
    [refused(403, 'mfa_required'), 'mfa_required'],
    [refused(404, 'tenant_not_found', 'not_found'), 'not_found'],
    [refused(409, 'support_system_tenant', 'conflict'), 'system_tenant'],
    [refused(400, 'support_requires_session', 'validation'), 'no_session'],
    [new ApiError({ kind: 'validation', status: 400 }), 'reason_invalid'],
    [new ApiError({ kind: 'server', status: 500 }), 'failed'],
  ])('a refusal reads as its own words (%#)', async (cause, reason) => {
    api.post.mockRejectedValue(cause);
    expect(await startSupport('t9', 'r')).toEqual({ ok: false, reason });
    expect(signIn).toHaveBeenCalledWith(cause);
    expect(cookie.write).not.toHaveBeenCalled();
  });

  it('★ a refusal the platform named is logged with its code', async () => {
    api.post.mockRejectedValue(refused(400, 'support_requires_session', 'validation'));
    await startSupport('t9', 'r');
    expect(warn).toHaveBeenCalledWith('support.start_failed', {
      code: 'support_requires_session',
      status: 400,
    });
  });

  it('★ already in a session: which workspace it is in, read from the platform', async () => {
    api.post.mockRejectedValue(refused(409, 'support_session_active', 'conflict'));
    api.get.mockResolvedValue({ ...SESSION, tenantName: 'Other shop' });
    expect(await startSupport('t9', 'r')).toEqual({
      ok: false,
      reason: 'active',
      activeName: 'Other shop',
    });
    expect(api.get.mock.calls[0]![0].endpoint.path).toBe('/api/system/support-sessions/current');
  });
});

describe('returning to a live session', () => {
  it('the platform names it: kept again', async () => {
    api.get.mockResolvedValue(SESSION);
    expect(await resumeSupport()).toEqual({ ok: true, session: SESSION });
    expect(cookie.write).toHaveBeenCalledWith(SESSION);
  });

  it('none live: said', async () => {
    api.get.mockResolvedValue(null);
    expect(await resumeSupport()).toEqual({ ok: false, reason: 'none' });
  });
});

describe('★★ leaving support mode', () => {
  it('★★ ends the session this browser holds, then clears it', async () => {
    cookie.held = { id: 'ss1', tenantId: 't9' };
    api.post.mockResolvedValue({});
    expect(await endSupport()).toEqual({ ok: true, tenantId: 't9' });
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe('/api/system/support-sessions/ss1/end');
    expect(cookie.clear).toHaveBeenCalledTimes(1);
  });

  it('no cookie: the live one the platform names', async () => {
    api.get.mockResolvedValue(SESSION);
    api.post.mockResolvedValue({});
    expect(await endSupport()).toEqual({ ok: true, tenantId: null });
    expect(api.post.mock.calls[0]![0].endpoint.path).toBe('/api/system/support-sessions/ss1/end');
  });

  it('nothing live anywhere: done, nothing sent', async () => {
    api.get.mockResolvedValue(null);
    expect(await endSupport()).toEqual({ ok: true, tenantId: null });
    expect(api.post).not.toHaveBeenCalled();
    expect(cookie.clear).toHaveBeenCalledTimes(1);
  });

  it('not this admin’s, or gone: nothing of theirs is live, so cleared', async () => {
    cookie.held = { id: 'ss1', tenantId: 't9' };
    api.post.mockRejectedValue(refused(404, 'support_session_not_found', 'not_found'));
    expect(await endSupport()).toEqual({ ok: true, tenantId: 't9' });
    expect(cookie.clear).toHaveBeenCalledTimes(1);
  });

  it('★★ an end that failed KEEPS the cookie: the banner and its Exit stay', async () => {
    cookie.held = { id: 'ss1', tenantId: 't9' };
    api.post.mockRejectedValue(new ApiError({ kind: 'network' }));
    expect(await endSupport()).toEqual({ ok: false, reason: 'failed' });
    expect(cookie.clear).not.toHaveBeenCalled();
  });
});
