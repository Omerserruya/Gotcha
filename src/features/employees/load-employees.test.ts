import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

import { loadReachability } from './load-employees';

/** As the real client does: the answer parsed by the request's own schema. */
const answering = (value: unknown) =>
  get.mockImplementation(async ({ payload }: { payload: { parse: (v: unknown) => unknown } }) =>
    payload.parse(value),
  );

beforeEach(() => {
  get.mockReset();
});

describe('★ where it answers: unknown is never "nowhere"', () => {
  it('the channels the playbook routes to it', async () => {
    answering({
      hasCanvas: true,
      reachable: true,
      channels: [{ channel: 'WHATSAPP', reach: 'always' }],
    });
    expect(await loadReachability('a')).toEqual([{ channel: 'WHATSAPP', reach: 'always' }]);
  });

  it('none: an empty list - the playbook routes nothing to it', async () => {
    answering({ hasCanvas: true, reachable: false, channels: [] });
    expect(await loadReachability('a')).toEqual([]);
  });

  it('★ an older service with no `channels`: null - unknown', async () => {
    answering({ hasCanvas: true, reachable: true });
    expect(await loadReachability('a')).toBeNull();
  });

  it('a failed read: null', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await loadReachability('a')).toBeNull();
  });
});
