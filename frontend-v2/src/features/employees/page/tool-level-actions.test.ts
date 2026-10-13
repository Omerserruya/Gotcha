import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { setEmployeeToolLevel } = await import('./tool-level-actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
});

describe('★★ E5 - one action’s level, for one employee', () => {
  it('PUT { level } to the employee’s tool, null meaning "like the workspace"', async () => {
    expect(await setEmployeeToolLevel('e1', 'woocommerce.create_refund', 'never')).toEqual({
      ok: true,
    });
    expect(put.mock.calls[0]![0].endpoint.path).toBe(
      '/api/ai-agents/e1/tool-levels/woocommerce.create_refund',
    );
    expect(put.mock.calls[0]![0].body).toEqual({ level: 'never' });
    await setEmployeeToolLevel('e1', 't', null);
    expect(put.mock.calls[1]![0].body).toEqual({ level: null });
  });

  it('★ 422 is "looser than the workspace", 403 permission, else failed', async () => {
    put.mockRejectedValueOnce(new ApiError({ status: 422, kind: 'validation' }));
    expect(await setEmployeeToolLevel('e1', 't', 'execute')).toEqual({
      ok: false,
      reason: 'looser',
    });
    put.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await setEmployeeToolLevel('e1', 't', 'ask')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    put.mockRejectedValueOnce(new Error('down'));
    expect(await setEmployeeToolLevel('e1', 't', 'ask')).toEqual({ ok: false, reason: 'failed' });
  });

  it('a level that is not one: nothing sent', async () => {
    expect(await setEmployeeToolLevel('e1', 't', 'always' as never)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(put).not.toHaveBeenCalled();
  });
});
