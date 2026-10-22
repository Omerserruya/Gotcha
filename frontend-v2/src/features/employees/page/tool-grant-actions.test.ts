import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('@/observability/logger', () => ({ logger: { warn: vi.fn() } }));

const { setEmployeeToolGrant } = await import('./tool-grant-actions');

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
});

describe('★★ giving an integration action to an employee (Backend 9339ca26)', () => {
  it('give: POST { toolName } to its builder tool; take away: attach false', async () => {
    expect(await setEmployeeToolGrant('e1', 'woocommerce.create_coupon', true)).toEqual({
      ok: true,
    });
    expect(post.mock.calls[0]![0].endpoint.path).toBe('/api/ai-agents/builder/e1/tool');
    expect(post.mock.calls[0]![0].body).toEqual({ toolName: 'woocommerce.create_coupon' });
    await setEmployeeToolGrant('e1', 'woocommerce.create_coupon', false);
    expect(post.mock.calls[1]![0].body).toEqual({
      toolName: 'woocommerce.create_coupon',
      attach: false,
    });
  });

  it('★ TOOL_NOT_PROVISIONED by its code - not every 404; 403 permission; else failed', async () => {
    post.mockRejectedValueOnce(
      new ApiError({ status: 404, kind: 'not_found', code: 'TOOL_NOT_PROVISIONED' }),
    );
    expect(await setEmployeeToolGrant('e1', 'woo.x', true)).toEqual({
      ok: false,
      reason: 'not_provisioned',
    });
    // The employee itself gone is a 404 too, without the code.
    post.mockRejectedValueOnce(new ApiError({ status: 404, kind: 'not_found' }));
    expect(await setEmployeeToolGrant('e1', 'woo.x', true)).toEqual({
      ok: false,
      reason: 'failed',
    });
    post.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await setEmployeeToolGrant('e1', 'woo.x', true)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    post.mockRejectedValueOnce(new Error('down'));
    expect(await setEmployeeToolGrant('e1', 'woo.x', false)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('a built-in, or no employee: nothing sent', async () => {
    expect(await setEmployeeToolGrant('e1', 'send_message', true)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(await setEmployeeToolGrant('', 'woo.x', true)).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });
});
