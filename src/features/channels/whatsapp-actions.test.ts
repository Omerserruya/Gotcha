import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { inspectNumbers } from './whatsapp-actions';

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ sessionId: 's', candidates: [] });
});

describe('★★ inspect at the wire — the popup’s assets ride along, and only those that exist', () => {
  const body = () => (post.mock.calls.at(-1)![0] as { body: unknown }).body;

  it('code, business and WABA ids', async () => {
    await inspectNumbers('abc', { businessPortfolioId: 'b1', wabaIds: ['w1'] });
    expect(body()).toStrictEqual({ code: 'abc', businessPortfolioId: 'b1', wabaIds: ['w1'] });
  });

  it('none told: the code alone', async () => {
    await inspectNumbers('abc', { wabaIds: [] });
    expect(body()).toStrictEqual({ code: 'abc' });
  });
});
