import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

const post = vi.hoisted(() => vi.fn());
const jar = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ post }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));
vi.mock('@/auth/google-sign-in', () => ({
  TERMS_PENDING_COOKIE: 'gotcha_terms_pending',
  termsPendingCookieOptions: () => ({ path: '/' }),
}));

const { acceptTerms } = await import('./terms-actions');

beforeEach(() => {
  post.mockReset().mockResolvedValue({ termsRequired: false });
  jar.delete.mockReset();
});

describe('★★ acceptTerms', () => {
  it('★★ posts the setup screen’s body and, recorded, drops the marker', async () => {
    expect(await acceptTerms(' קראתי ואישרתי ')).toBe('accepted');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { terms: true, privacy: true, locale: 'he', capturedText: 'קראתי ואישרתי' },
      }),
    );
    expect(jar.delete).toHaveBeenCalledWith({ name: 'gotcha_terms_pending', path: '/' });
  });

  it.each([503, 400, 403])(
    '⚠⚠ a %i records nothing: failed, and the marker stays',
    async (status) => {
      post.mockRejectedValue(new ApiError({ kind: 'server', status }));
      expect(await acceptTerms('x')).toBe('failed');
      expect(jar.delete).not.toHaveBeenCalled();
    },
  );
});
