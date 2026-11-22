import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const del = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ delete: del }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { disconnectGoogle } = await import('./google-actions');

beforeEach(() => {
  del.mockReset().mockResolvedValue({ ok: true });
  revalidatePath.mockReset();
});

const refused = (status: number, error: string) =>
  new ApiError({
    kind: status >= 500 ? 'integration' : 'conflict',
    status,
    developerMessage: error,
  });

describe('★★ disconnectGoogle', () => {
  it('removes, and the page reads again', async () => {
    expect(await disconnectGoogle()).toBe('disconnected');
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({ path: '/api/account/sign-in-connections/google' }),
      }),
    );
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('⚠⚠ 409 no_other_sign_in is a refusal, never a failure', async () => {
    del.mockRejectedValue(refused(409, 'no_other_sign_in'));
    expect(await disconnectGoogle()).toBe('refused');
  });

  it.each(['not_connected', 'not_available'])(
    '★ 404 %s: already gone, and the page reads again',
    async (error) => {
      del.mockRejectedValue(refused(404, error));
      expect(await disconnectGoogle()).toBe('gone');
      expect(revalidatePath).toHaveBeenCalled();
    },
  );

  it('⚠ 502 idp_unavailable, or anything else: failed', async () => {
    del.mockRejectedValue(refused(502, 'idp_unavailable'));
    expect(await disconnectGoogle()).toBe('failed');
  });
});
