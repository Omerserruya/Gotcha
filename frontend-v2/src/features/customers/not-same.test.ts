import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => api }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { markNotSame } from './identity-actions';

const path = (call: unknown[]) => (call[0] as { endpoint: { path: string } }).endpoint.path;

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe('★★ 04 at the wire (conversation e5a56fd3)', () => {
  it('marks: POST /api/identity/not-same { contactIds: [a, b] }', async () => {
    api.post.mockResolvedValue({});
    expect(await markNotSame('k1', 'k2')).toEqual({ ok: true });
    expect(path(api.post.mock.calls[0]!)).toBe('/api/identity/not-same');
    expect(api.post.mock.calls[0]![0]).toMatchObject({ body: { contactIds: ['k1', 'k2'] } });
  });

  it('the same id twice is refused before any call', async () => {
    expect(await markNotSame('k1', 'k1')).toEqual({ ok: false, reason: 'failed' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('409 ALREADY_SAME_PERSON, 404 CONTACT_NOT_FOUND, 403 - each by name', async () => {
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, code: 'ALREADY_SAME_PERSON' }),
    );
    expect(await markNotSame('k1', 'k2')).toEqual({ ok: false, reason: 'already_same' });
    api.post.mockRejectedValueOnce(
      new ApiError({ kind: 'not_found', status: 404, code: 'CONTACT_NOT_FOUND' }),
    );
    expect(await markNotSame('k1', 'k2')).toEqual({ ok: false, reason: 'gone' });
    api.post.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await markNotSame('k1', 'k2')).toEqual({ ok: false, reason: 'forbidden' });
  });
});
