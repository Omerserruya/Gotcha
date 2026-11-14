import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const { post, patch } = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post, patch }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { addPrivateContact, refreshUnprofiled, setPrimaryNumber } from './number-actions';

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({});
  patch.mockReset();
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

describe('★ "Refresh from Meta" for a number with no record here (Backend 7131f530)', () => {
  it('posts to the same refresh route, by the channel account id', async () => {
    expect(await refreshUnprofiled('ca1')).toEqual({ ok: true });
    const call = post.mock.calls[0]![0] as { endpoint: { path: string } };
    expect(call.endpoint.path).toBe('/api/channels/whatsapp/numbers/ca1/refresh');
  });

  it.each([
    [429, 'too_soon'],
    [409, 'reconnect'],
    [502, 'meta_silent'],
    [404, 'not_found'],
    [403, 'forbidden'],
    [500, 'failed'],
  ])('★ %i is said as %s', async (status, reason) => {
    post.mockRejectedValueOnce(refused(status, 'x'));
    expect(await refreshUnprofiled('ca1')).toEqual({ ok: false, reason });
  });
});

describe('★★ Set as primary (PATCH /whatsapp/primary) - mapped by status, never by a code', () => {
  it('sends the channel account, and returns the primary the server answers with', async () => {
    patch.mockResolvedValueOnce({ channelAccountId: 'ca1', source: 'chosen' });
    expect(await setPrimaryNumber('ca1')).toEqual({
      ok: true,
      primary: { channelAccountId: 'ca1', source: 'chosen' },
    });
    const call = patch.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };
    expect(call.endpoint.path).toBe('/api/channels/whatsapp/primary');
    expect(call.body).toStrictEqual({ channelAccountId: 'ca1' });
  });

  it.each([
    // The malformed-body 400 carries no code: `{ error: "Validation failed", details }`.
    [400, 'Validation failed', 'failed'],
    [404, 'WHATSAPP_NUMBER_NOT_FOUND', 'not_found'],
    [409, 'WHATSAPP_NUMBER_NOT_ACTIVE', 'not_active'],
    [403, 'forbidden', 'forbidden'],
    [500, 'boom', 'failed'],
  ])('%i %s -> %s', async (status, error, reason) => {
    patch.mockRejectedValueOnce(refused(status, error));
    expect(await setPrimaryNumber('ca1')).toEqual({ ok: false, reason });
  });
});
