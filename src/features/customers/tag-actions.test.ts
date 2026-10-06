import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* Mocked for the whole file: nothing here tags a real contact. */
const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { tagCustomers } from './tag-actions';

beforeEach(() => {
  post.mockReset();
});

describe('★★ tag the picked - the route’s rules, before and after', () => {
  it('POST /api/contacts/tags with the ids once each and the trimmed tag, as `add`', async () => {
    post.mockResolvedValue({ data: { k1: ['VIP'], k2: ['VIP'] } });
    expect(await tagCustomers(['k1', 'k2', 'k1'], '  VIP ')).toEqual({ ok: true, tagged: 2 });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/contacts/tags');
    expect(call.body).toStrictEqual({ contactIds: ['k1', 'k2'], add: ['VIP'] });
  });

  it('nothing sent for an empty or over-long tag, or more than one all-or-nothing call', async () => {
    expect(await tagCustomers(['k1'], '   ')).toEqual({ ok: false, reason: 'invalid' });
    expect(await tagCustomers(['k1'], 'x'.repeat(41))).toEqual({ ok: false, reason: 'invalid' });
    const many = Array.from({ length: 101 }, (_, i) => `k${i}`);
    expect(await tagCustomers(many, 'VIP')).toEqual({ ok: false, reason: 'too_many_people' });
    expect(post).not.toHaveBeenCalled();
  });

  it('the refusals, by name', async () => {
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'validation', status: 400, developerMessage: 'too_many_tags' }),
    );
    expect(await tagCustomers(['k1'], 'VIP')).toEqual({ ok: false, reason: 'too_many_tags' });
    post.mockRejectedValueOnce(new ApiError({ kind: 'server', status: 404 }));
    expect(await tagCustomers(['k1'], 'VIP')).toEqual({ ok: false, reason: 'not_found' });
  });
});
