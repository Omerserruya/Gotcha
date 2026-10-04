import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { mergeContacts } from './identity-actions';

beforeEach(() => {
  post.mockReset();
});

describe('★★ merge at the wire', () => {
  it('POST /api/identity/merge { targetId, sourceId } and nothing else', async () => {
    post.mockResolvedValue({});
    expect(await mergeContacts('k1', 'k2')).toEqual({ ok: true });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/identity/merge');
    expect(call.body).toStrictEqual({ targetId: 'k1', sourceId: 'k2' });
  });

  it('one contact into itself is never sent', async () => {
    expect(await mergeContacts('k1', 'k1')).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'gone'],
    [409, 'conflict'],
    [403, 'forbidden'],
    [500, 'failed'],
  ] as const)('%i → %s', async (status, reason) => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: status === 403 ? 'authorization' : 'server', status });
    });
    expect(await mergeContacts('k1', 'k2')).toEqual({ ok: false, reason });
  });
});
