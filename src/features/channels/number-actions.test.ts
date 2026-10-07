import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { addPrivateContact } from './number-actions';

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
});

const refused = (status: number, error: string) =>
  new ApiError({ kind: 'validation', status, developerMessage: error });

describe('★★ a private contact is added ON one WhatsApp number (Backend, 2026-10-07)', () => {
  it('the number always goes with it - the route refuses without one', async () => {
    await addPrivateContact({ value: ' 054-123-4567 ', note: '', channelAccountId: 'ca1' });
    expect((post.mock.calls[0]![0] as { body: unknown }).body).toStrictEqual({
      value: '054-123-4567',
      channelAccountId: 'ca1',
    });
  });

  it('★ the route’s two 400s are two different things', async () => {
    post.mockRejectedValueOnce(refused(400, 'invalid_number'));
    expect(await addPrivateContact({ value: '0', note: '', channelAccountId: 'ca1' })).toEqual({
      ok: false,
      reason: 'invalid_number',
    });
    post.mockRejectedValueOnce(refused(400, 'channel_account_required'));
    expect(
      await addPrivateContact({ value: '054-123-4567', note: '', channelAccountId: 'ca1' }),
    ).toEqual({ ok: false, reason: 'number_gone' });
    post.mockRejectedValueOnce(refused(404, 'channel_account_not_found'));
    expect(
      await addPrivateContact({ value: '054-123-4567', note: '', channelAccountId: 'gone' }),
    ).toEqual({ ok: false, reason: 'number_gone' });
  });
});
