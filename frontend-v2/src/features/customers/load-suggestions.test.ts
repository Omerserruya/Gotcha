import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

import { loadSuggestions } from './load-suggestions';

/** The transport unwraps `{ data }` and parses the array with the given payload. */
const answer = (data: unknown) =>
  get.mockImplementationOnce(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(data),
  );

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

describe('★★ the pairs come from the server - GET /api/identity/suggestions (83579ac8)', () => {
  it('reads the pending pairs, as the route sends them', async () => {
    answer([
      {
        id: 'identity:link:ig1:wa1',
        source: 'link',
        contactIds: ['ig1', 'wa1'],
        signal: 'same_name',
        identifier: null,
        status: 'PENDING',
        at: '2026-10-11T10:00:00Z',
        contacts: [
          { id: 'ig1', label: 'Instagram customer', channel: 'INSTAGRAM' },
          { id: 'wa1', label: 'Omer Tsruya', channel: 'WHATSAPP' },
        ],
      },
    ]);
    const pairs = await loadSuggestions();
    expect(pairs?.map((p) => p.contactIds)).toEqual([['ig1', 'wa1']]);
    const request = get.mock.calls[0]![0] as { endpoint: { path: string }; query?: unknown };
    expect(request.endpoint.path).toBe('/api/identity/suggestions');
    // The pending ones only: no ?status=APPLIED.
    expect(request.query).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('none is an empty list, not a failure', async () => {
    answer([]);
    expect(await loadSuggestions()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['403', new ApiError({ kind: 'authorization', status: 403 })],
    ['a dead service', new Error('ECONNREFUSED')],
  ])('a failed read (%s) is null, and logged - never "no pairs"', async (_, error) => {
    get.mockRejectedValueOnce(error);
    expect(await loadSuggestions()).toBeNull();
    expect(warn).toHaveBeenCalledWith('customers.suggestions_failed', { cause: error });
  });
});
