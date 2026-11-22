import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

const { loadGoogleConnection } = await import('./load-google');

const google = (over: Record<string, unknown> = {}) => ({
  available: true,
  connected: false,
  email: null,
  connectedAt: null,
  canDisconnect: false,
  reason: null,
  ...over,
});

beforeEach(() => {
  get.mockReset();
});

describe('★★ loadGoogleConnection', () => {
  it('reads the card', async () => {
    get.mockResolvedValue({ google: google({ connected: true, email: 'a@b.co' }) });
    expect(await loadGoogleConnection()).toEqual({
      kind: 'read',
      google: google({ connected: true, email: 'a@b.co' }),
    });
  });

  it('★ available: false - Google is not set up here - is off: no card', async () => {
    get.mockResolvedValue({ google: google({ available: false }) });
    expect(await loadGoogleConnection()).toEqual({ kind: 'off' });
  });

  it('⚠⚠ 409 no_identity is "couldn’t read", never "not connected"', async () => {
    get.mockImplementation(async () => {
      throw new ApiError({ kind: 'conflict', status: 409, developerMessage: 'no_identity' });
    });
    expect(await loadGoogleConnection()).toEqual({ kind: 'unread' });
  });

  it('⚠⚠ 502 idp_unavailable is "couldn’t read", never "not connected"', async () => {
    get.mockImplementation(async () => {
      throw new ApiError({ kind: 'integration', status: 502, developerMessage: 'idp_unavailable' });
    });
    expect(await loadGoogleConnection()).toEqual({ kind: 'unread' });
  });
});
