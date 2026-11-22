import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));

const { loadSignUpConfig } = await import('./load-signup-config');

beforeEach(() => {
  get.mockReset();
});

describe('★★ loadSignUpConfig', () => {
  it('reads the switch and the trial', async () => {
    get.mockResolvedValue({ enabled: true, trialDays: 14, cardRequiredAfterDays: 14 });
    expect(await loadSignUpConfig()).toEqual({
      enabled: true,
      trialDays: 14,
      cardRequiredAfterDays: 14,
    });
  });

  it('⚠⚠ unread is CLOSED: nothing is offered that the server might refuse', async () => {
    get.mockImplementation(async () => {
      throw new Error('404');
    });
    expect((await loadSignUpConfig()).enabled).toBe(false);
  });
});
