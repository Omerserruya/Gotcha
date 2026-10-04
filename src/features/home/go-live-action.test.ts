import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { goLive } from './go-live-action';

beforeEach(() => {
  post.mockReset();
});

describe('★★ Go live at the wire', () => {
  it('POST /api/onboarding/complete { skipEmployee: true } — never a second employee, never skipping the store', async () => {
    post.mockResolvedValue({ data: { status: 'ACTIVE' } });
    expect(await goLive()).toEqual({ ok: true });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/onboarding/complete');
    expect(call.body).toStrictEqual({ skipEmployee: true });
  });

  it.each([
    ['core_system_required', 400, 'store'],
    ['Business profile is required before activation', 400, 'profile'],
    ['An active admin account is required before activation', 400, 'admin'],
    [undefined, 403, 'forbidden'],
    [undefined, 500, 'failed'],
  ] as const)('%s (%i) → %s', async (message, status, reason) => {
    post.mockImplementation(async () => {
      throw new ApiError({
        kind: status === 403 ? 'authorization' : 'validation',
        status,
        developerMessage: message,
      });
    });
    expect(await goLive()).toEqual({ ok: false, reason });
  });
});
