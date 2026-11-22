import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));

const { submitSignUp } = await import('./actions');

const FORM = { name: 'Maya', email: 'm@aviv.co', businessName: 'Aviv' };

beforeEach(() => {
  post.mockReset().mockResolvedValue({ ok: true });
});

describe('★★ submitSignUp', () => {
  it('★★ posts the trimmed form with the Terms fields, and any 2xx is "sent"', async () => {
    expect(await submitSignUp(FORM, 'קראתי ואישרתי')).toEqual({ kind: 'sent' });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({ path: '/api/auth/signup' }),
        body: expect.objectContaining({
          terms: true,
          privacy: true,
          locale: 'he',
          email: 'm@aviv.co',
        }),
      }),
    );
  });

  it.each([
    [429, { kind: 'rateLimited' }],
    [404, { kind: 'closed' }],
    [403, { kind: 'closed' }],
    [500, { kind: 'failed' }],
  ])('⚠ %i reads as %j', async (status, want) => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'server', status });
    });
    expect(await submitSignUp(FORM, 'x')).toEqual(want);
  });

  it('★ a 400 names its field from Backend’s fields map', async () => {
    post.mockImplementation(async () => {
      throw new ApiError({ kind: 'validation', status: 400, fields: { businessName: 'required' } });
    });
    expect(await submitSignUp(FORM, 'x')).toEqual({ kind: 'invalid', field: 'businessName' });
  });
});
