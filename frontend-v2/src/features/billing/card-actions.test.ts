import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/* ⚠ A card session creates a client at the provider - mocked for this whole file. */
const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: async () => {} }));
const writes = vi.hoisted(() => ({ on: true }));
vi.mock('@/api/client/billing-writes', () => ({ billingWritesEnabled: () => writes.on }));

import { confirmCardSession, startCardSession } from './actions';

const answering =
  (value: unknown) =>
  async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value);
const path = () => (post.mock.calls.at(-1)![0] as { endpoint: { path: string } }).endpoint.path;

beforeEach(() => {
  post.mockReset();
  writes.on = true;
});

describe('★★ billing writes off: both card actions refuse before any request', () => {
  it('start and confirm are `held`, and nothing is posted', async () => {
    writes.on = false;
    expect(await startCardSession()).toEqual({ ok: false, reason: 'held' });
    expect(await confirmCardSession('s1')).toEqual({ ok: false, reason: 'held' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★ start: the provider’s secure page, and only a secure one', () => {
  it('POST /billing/payment-methods/session → where to go and the session id', async () => {
    post.mockImplementation(answering({ redirectUrl: 'https://pay.example/p/1', sessionId: 's1' }));
    expect(await startCardSession()).toEqual({
      ok: true,
      redirectUrl: 'https://pay.example/p/1',
      sessionId: 's1',
    });
    expect(path()).toBe('/api/billing/payment-methods/session');
    // Back to v2's own return page - the old app's otherwise.
    expect(post.mock.calls[0]![0]).toMatchObject({ body: { returnTo: 'v2' } });
  });

  it('a page that is not https is never handed to the browser', async () => {
    post.mockImplementation(answering({ redirectUrl: 'http://pay.example/p/1', sessionId: 's1' }));
    expect(await startCardSession()).toEqual({ ok: false, reason: 'failed' });
    post.mockImplementation(answering({ redirectUrl: 'javascript:alert(1)', sessionId: 's1' }));
    expect(await startCardSession()).toEqual({ ok: false, reason: 'failed' });
  });

  it('409s by their code: no billing account; anything else, unavailable; 403 forbidden', async () => {
    post.mockRejectedValueOnce(
      new ApiError({ kind: 'conflict', status: 409, developerMessage: 'no_billable_entity' }),
    );
    expect(await startCardSession()).toEqual({ ok: false, reason: 'no_account' });
    post.mockRejectedValueOnce(
      new ApiError({
        kind: 'conflict',
        status: 409,
        developerMessage: 'payment_setup_unavailable',
      }),
    );
    expect(await startCardSession()).toEqual({ ok: false, reason: 'unavailable' });
    post.mockRejectedValueOnce(new ApiError({ kind: 'authorization', status: 403 }));
    expect(await startCardSession()).toEqual({ ok: false, reason: 'forbidden' });
  });
});

describe('★ confirm: what the provider says, in kinds the page can say', () => {
  it('STORED with the card; PENDING with its reason; an unknown reason is `unknown`', async () => {
    post.mockImplementationOnce(
      answering({ status: 'STORED', paymentMethod: { id: 'pm', brand: 'Visa', last4: '4417' } }),
    );
    expect(await confirmCardSession('s1')).toEqual({
      ok: true,
      status: 'STORED',
      card: { brand: 'Visa', last4: '4417' },
    });
    expect(path()).toBe('/api/billing/payment-methods/confirm');
    expect(post.mock.calls[0]![0]).toMatchObject({ body: { sessionId: 's1' } });
    post.mockImplementationOnce(answering({ status: 'PENDING', reason: 'expired' }));
    expect(await confirmCardSession('s1')).toEqual({
      ok: true,
      status: 'PENDING',
      reason: 'expired',
    });
    post.mockImplementationOnce(answering({ status: 'PENDING', reason: 'something_new' }));
    expect(await confirmCardSession('s1')).toEqual({
      ok: true,
      status: 'PENDING',
      reason: 'unknown',
    });
  });

  it('a session that is not this tenant’s is not_found (404); none at all, without a request', async () => {
    post.mockRejectedValueOnce(new ApiError({ kind: 'not_found', status: 404 }));
    expect(await confirmCardSession('other')).toEqual({ ok: false, reason: 'not_found' });
    post.mockReset();
    expect(await confirmCardSession('')).toEqual({ ok: false, reason: 'not_found' });
    expect(post).not.toHaveBeenCalled();
  });
});
