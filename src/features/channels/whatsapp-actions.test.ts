import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));

import { connectNumber, inspectNumbers, resumeNumber } from './whatsapp-actions';

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ sessionId: 's', candidates: [] });
});

describe('★★ inspect at the wire - the popup’s assets ride along, and only those that exist', () => {
  const body = () => (post.mock.calls.at(-1)![0] as { body: unknown }).body;

  it('code, business and WABA ids', async () => {
    await inspectNumbers('abc', { businessPortfolioId: 'b1', wabaIds: ['w1'] }, 'business-app');
    expect(body()).toStrictEqual({
      code: 'abc',
      path: 'business-app',
      businessPortfolioId: 'b1',
      wabaIds: ['w1'],
    });
  });

  it('none told: the code alone', async () => {
    await inspectNumbers('abc', { wabaIds: [] });
    expect(body()).toStrictEqual({ code: 'abc', path: 'new' });
  });
});

describe('★★ connect and resume at the wire', () => {
  const body = () => (post.mock.calls.at(-1)![0] as { body: unknown }).body;

  it('connect: the session and ONE number; the PIN only when given', async () => {
    post.mockResolvedValue({ pendingAction: null, message: null });
    await connectNumber('s1', 'p1');
    expect(body()).toStrictEqual({ sessionId: 's1', phoneNumberId: 'p1' });
    await connectNumber('s1', 'p1', '123456');
    expect(body()).toStrictEqual({ sessionId: 's1', phoneNumberId: 'p1', twoStepPin: '123456' });
  });

  it('a PIN that is not six digits never leaves', async () => {
    post.mockClear();
    expect(await connectNumber('s1', 'p1', '12345')).toEqual({ ok: false, message: 'pin' });
    expect(post).not.toHaveBeenCalled();
  });

  it('★ resume sends `twoStepPin` - the field the route reads (`pin` was stripped)', async () => {
    post.mockResolvedValue({});
    await resumeNumber('n1', '123456');
    expect(body()).toStrictEqual({ twoStepPin: '123456' });
  });
});
