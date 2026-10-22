import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { rerunReadiness } = await import('./readiness-actions');

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
});

describe('★★ H7 - Run again', () => {
  it('POSTs the readiness test for this employee, in the reader’s language, with a model’s time', async () => {
    expect(await rerunReadiness('e1')).toEqual({ ok: true });
    const call = post.mock.calls[0]![0];
    expect(call.endpoint.path).toBe('/api/ai-agents/builder/e1/readiness-test');
    expect(call.body).toEqual({ locale: 'he' });
    expect(call.timeoutMs).toBeGreaterThan(20_000);
  });

  it('★ 403 permission, 404 gone, a timeout is "still running", anything else failed', async () => {
    post.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await rerunReadiness('e1')).toEqual({ ok: false, reason: 'forbidden' });
    post.mockRejectedValueOnce(new ApiError({ status: 404, kind: 'not_found' }));
    expect(await rerunReadiness('e1')).toEqual({ ok: false, reason: 'missing' });
    post.mockRejectedValueOnce(new ApiError({ status: 0, kind: 'timeout' }));
    expect(await rerunReadiness('e1')).toEqual({ ok: false, reason: 'slow' });
    post.mockRejectedValueOnce(new ApiError({ status: 502, kind: 'server' }));
    expect(await rerunReadiness('e1')).toEqual({ ok: false, reason: 'failed' });
    post.mockRejectedValueOnce(new Error('down'));
    expect(await rerunReadiness('e1')).toEqual({ ok: false, reason: 'failed' });
  });

  it('no id: nothing sent', async () => {
    expect(await rerunReadiness('')).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });
});
