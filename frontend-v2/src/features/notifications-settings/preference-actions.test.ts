import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const patch = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ patch }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import {
  saveEventChannel,
  savePreferenceSwitch,
  saveQuietHours,
  type PreferenceSwitchKey,
} from './preference-actions';

beforeEach(() => {
  patch.mockReset();
});

describe('★★ a switch writes the person’s own row, one key at a time', () => {
  it('PATCH /api/notification-preferences/me with that key alone; the stored answer back', async () => {
    patch.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({ inApp: true, email: false, whatsapp: false, approvals: true }),
    );
    const done = await savePreferenceSwitch('email', false);
    expect(patch.mock.calls[0]![0]).toMatchObject({
      endpoint: { path: '/api/notification-preferences/me' },
    });
    expect((patch.mock.calls[0]![0] as { body: object }).body).toEqual({ email: false });
    expect(done).toMatchObject({ ok: true, preferences: { email: false } });
  });

  it('a key the platform has no switch for is refused before any call', async () => {
    expect(await savePreferenceSwitch('quietHours' as PreferenceSwitchKey, true)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('403 (an account with no preferences of its own) is said apart from a failure', async () => {
    patch.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await savePreferenceSwitch('inApp', true)).toEqual({ ok: false, reason: 'forbidden' });
    patch.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await savePreferenceSwitch('inApp', true)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('★★ quiet hours - one window or none, checked as the route checks it', () => {
  const stored = (quietHours: unknown) =>
    patch.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({ inApp: true, email: true, whatsapp: false, approvals: true, quietHours }),
    );

  it('PATCH { quietHours: { from, to } } - a window past midnight is the common case', async () => {
    stored({ from: '22:00', to: '07:00' });
    const done = await saveQuietHours({ from: '22:00', to: '07:00' });
    expect((patch.mock.calls[0]![0] as { body: object }).body).toEqual({
      quietHours: { from: '22:00', to: '07:00' },
    });
    expect(done).toMatchObject({
      ok: true,
      preferences: { quietHours: { from: '22:00', to: '07:00' } },
    });
  });

  it('off is null - both ends together', async () => {
    stored(null);
    await saveQuietHours(null);
    expect((patch.mock.calls[0]![0] as { body: object }).body).toEqual({ quietHours: null });
  });

  it('not 24-hour, or the same time twice: refused before any call', async () => {
    expect(await saveQuietHours({ from: '9:00', to: '17:00' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await saveQuietHours({ from: '24:00', to: '07:00' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await saveQuietHours({ from: '08:00', to: '08:00' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('the route’s 400 is invalid; 403 forbidden; else failed', async () => {
    patch.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    expect(await saveQuietHours({ from: '22:00', to: '07:00' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    patch.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await saveQuietHours({ from: '22:00', to: '07:00' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    patch.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveQuietHours({ from: '22:00', to: '07:00' })).toEqual({
      ok: false,
      reason: 'failed',
    });
  });
});

describe('★★ one event on one channel (notifications 63307535)', () => {
  it('PATCH {events:{<type>:{<channel>: on}}} - that and nothing else', async () => {
    patch.mockResolvedValue({});
    expect(await saveEventChannel('broadcast.completed', 'email', false)).toEqual({ ok: true });
    expect((patch.mock.calls[0]![0] as { body: object }).body).toEqual({
      events: { 'broadcast.completed': { email: false } },
    });
  });

  it('⚠ 400 UNKNOWN_EVENT is "unknown"; 403 "forbidden"; anything else "failed"', async () => {
    patch.mockRejectedValueOnce(new ApiError({ kind: 'validation', status: 400 }));
    expect(await saveEventChannel('gone.event', 'inApp', true)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    patch.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await saveEventChannel('x', 'inApp', true)).toEqual({ ok: false, reason: 'forbidden' });
    patch.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 500 }));
    expect(await saveEventChannel('x', 'inApp', true)).toEqual({ ok: false, reason: 'failed' });
  });

  it('a channel the platform has no per-event switch for is never sent', async () => {
    expect(await saveEventChannel('x', 'whatsapp' as never, true)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(patch).not.toHaveBeenCalled();
  });
});
