import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const put = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { saveSignUpSettings } = await import('./signup-settings-actions');
const S = { enabled: true, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000 };

beforeEach(() => {
  put.mockReset().mockResolvedValue(S);
});

describe('★★ saveSignUpSettings', () => {
  it('puts the three values', async () => {
    expect(await saveSignUpSettings(S)).toBe('saved');
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({ path: '/api/system/self-signup' }),
        body: S,
      }),
    );
  });

  it.each([
    [400, 'invalid'],
    [403, 'forbidden'],
    [500, 'failed'],
  ])('%i is %s', async (status, want) => {
    put.mockImplementation(async () => {
      throw new ApiError({ kind: 'server', status });
    });
    expect(await saveSignUpSettings(S)).toBe(want);
  });
});
