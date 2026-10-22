import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));

import { acceptSuggestion, markNotSame, unlinkContacts } from './identity-actions';

beforeEach(() => {
  post.mockReset();
  revalidatePath.mockReset();
});

const call = () => post.mock.calls[0]![0] as { endpoint: { path: string }; body: unknown };

describe('★★ "Merge them" accepts the server’s suggestion (Backend 83579ac8)', () => {
  it('POST /api/identity/suggestions/accept { contactIds: [a, b] } and nothing else', async () => {
    post.mockResolvedValue({ data: { outcome: 'linked' } });
    expect(await acceptSuggestion('wa2', 'ig1')).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(call().endpoint.path).toBe('/api/identity/suggestions/accept');
    expect(call().body).toStrictEqual({ contactIds: ['wa2', 'ig1'] });
    // The list and the card are read again.
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(app)/customers', 'page');
  });

  it('one contact with itself is never sent', async () => {
    expect(await acceptSuggestion('k1', 'k1')).toEqual({ ok: false, reason: 'failed' });
    expect(await acceptSuggestion('', 'k1')).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'CONTACT_NOT_FOUND', 'gone'],
    [409, 'NOT_SAME', 'not_same'],
    [403, undefined, 'forbidden'],
    [400, 'TWO_CONTACTS_REQUIRED', 'failed'],
    [500, undefined, 'failed'],
  ] as const)('%i %s → %s, and nothing is revalidated', async (status, code, reason) => {
    post.mockRejectedValue(
      new ApiError({ kind: status === 403 ? 'authorization' : 'server', status, code }),
    );
    expect(await acceptSuggestion('wa2', 'ig1')).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('★★ "Not the same" marks the pair - never /unlink, which a suggested pair was not', () => {
  it('POST /api/identity/not-same { contactIds: [a, b] }, then the page is read again', async () => {
    post.mockResolvedValue({});
    expect(await markNotSame('wa2', 'ig1')).toEqual({ ok: true });
    expect(call().endpoint.path).toBe('/api/identity/not-same');
    expect(call().body).toStrictEqual({ contactIds: ['wa2', 'ig1'] });
    expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(app)/customers', 'page');
  });
});

describe('★★ F1 - "ביטול צימוד" posts the link’s own unlink body', () => {
  it('exactly { contactIds: [a, b] } to /api/identity/unlink', async () => {
    post.mockResolvedValueOnce({ data: { outcome: 'unlinked' } });
    expect(await unlinkContacts(['c1', 'c2'])).toEqual({ ok: true });
    expect(call().endpoint.path).toBe('/api/identity/unlink');
    expect(call().body).toEqual({ contactIds: ['c1', 'c2'] });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it('★ not a pair: nothing is sent', async () => {
    for (const ids of [[], ['c1'], ['c1', 'c1'], ['a', 'b', 'c']]) {
      expect(await unlinkContacts(ids)).toEqual({ ok: false, reason: 'failed' });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('404 is "no longer linked", 403 is permission, anything else failed', async () => {
    post.mockRejectedValueOnce(new ApiError({ status: 404, kind: 'not_found' }));
    expect(await unlinkContacts(['a', 'b'])).toEqual({ ok: false, reason: 'not_linked' });
    post.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(await unlinkContacts(['a', 'b'])).toEqual({ ok: false, reason: 'forbidden' });
    post.mockRejectedValueOnce(new Error('down'));
    expect(await unlinkContacts(['a', 'b'])).toEqual({ ok: false, reason: 'failed' });
  });
});
