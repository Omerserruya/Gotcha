import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';
import { approvalSchema } from '@/api/contracts/approvals';

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get, post }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-gotcha-return-to': '/en/approvals' }),
}));

import { approveRequest } from './actions';
import { loadApprovalCustomers } from './approval-customers';

const at = '2026-10-04T09:00:00.000Z';
const pending = (id: string, contactId: string | null, conversationId: string | null) =>
  approvalSchema.parse({
    id,
    tool: 't',
    summary: 's',
    contactId,
    conversationId,
    expiresAt: at,
    createdAt: at,
  });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('★★ 03’s customer, from what can be read', () => {
  it('the contact names them; with no conversation, no orders and no mood are asked for', async () => {
    get.mockImplementation(
      async ({
        endpoint,
        payload,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
      }) => {
        if (endpoint.path === '/api/contacts/k1')
          return payload.parse({ displayName: 'Matan Amran', createdAt: '2024-03-10T00:00:00Z' });
        throw new Error(`unexpected ${endpoint.path}`);
      },
    );
    post.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
      payload.parse({ ok: true, meta: { mood: ' frustrated ' } }),
    );
    const customers = await loadApprovalCustomers([pending('a1', 'k1', null)]);
    expect(customers.a1).toEqual({
      name: 'Matan Amran',
      since: '2024-03-10T00:00:00Z',
      lifetime: null,
      refunds: null,
      mood: 'frustrated',
    });
    // The brief is read without `refresh` - never a model call on a page load.
    expect(post.mock.calls[0]![0].body).toStrictEqual({ contactId: 'k1' });
  });

  it('no contact: the conversation’s name; a failed read is "-", never a thrown page', async () => {
    get.mockImplementation(
      async ({
        endpoint,
        payload,
      }: {
        endpoint: { path: string };
        payload: { parse: (v: unknown) => unknown };
      }) => {
        if (endpoint.path === '/api/conversations/c1')
          return payload.parse({ customerName: 'Dana Cohen' });
        throw new Error('down');
      },
    );
    const customers = await loadApprovalCustomers([pending('a1', null, 'c1')]);
    expect(customers.a1).toEqual({
      name: 'Dana Cohen',
      since: null,
      lifetime: null,
      refunds: null,
      mood: null,
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('★★ approve at the wire (backend 05979604)', () => {
  const ok = {
    approval: { id: 'a1', tool: 't', summary: 's', expiresAt: at, createdAt: at },
    edit: null,
    dispatch: { ok: true },
  };

  it('as asked: an empty body; edited: { edits: { amount } } and nothing else', async () => {
    post.mockResolvedValue(ok);
    await approveRequest('a1');
    expect(post.mock.calls[0]![0].body).toStrictEqual({});
    await approveRequest('a1', { amount: 120 });
    expect(post.mock.calls[1]![0].body).toStrictEqual({ edits: { amount: 120 } });
    // One field per request (backend f16a5afa).
    await approveRequest('a1', { percentage: 12.5 });
    expect(post.mock.calls[2]![0].body).toStrictEqual({ edits: { percentage: 12.5 } });
  });

  it('a non-positive amount is never sent', async () => {
    expect(await approveRequest('a1', { amount: 0 })).toEqual({ ok: false, reason: 'failed' });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    'edit_not_allowed',
    'amount_above_original',
    'invalid_amount',
    'edit_requires_original_amount',
  ])('a 400 %s comes back as that reason', async (code) => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'validation', status: 400, developerMessage: code });
    });
    expect(await approveRequest('a1', { amount: 120 })).toEqual({ ok: false, reason: code });
  });
});

describe('★★ a 401 while deciding is sign-in, not "that didn’t go through"', () => {
  it('approve: the session is over → sign-in with the way back', async () => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'authentication', status: 401 });
    });
    await expect(approveRequest('a1')).rejects.toThrow(
      `REDIRECT /api/auth/login?returnTo=${encodeURIComponent('/en/approvals')}`,
    );
  });
});
