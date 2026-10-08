import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const patch = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ patch }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { savePreferenceSwitch, type PreferenceSwitchKey } from './preference-actions';

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
