import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  value: { enabled: false, trialDays: null, cardRequiredAfterDays: null },
}));
vi.mock('@/features/signup/load-signup-config', () => ({
  loadSignUpConfig: async () => config.value,
}));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('./SignUpPanel', () => ({ SignUpPanel: () => null }));

const { default: SignUpPage } = await import('./page');

describe('★★ /sign-up exists only while the server’s switch is on', () => {
  it('⚠⚠ closed (or unread): a 404, nothing of it shows', async () => {
    await expect(SignUpPage({ params: Promise.resolve({ locale: 'he' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });

  it('★ open: the page', async () => {
    config.value = { enabled: true, trialDays: 14, cardRequiredAfterDays: 14 } as never;
    expect(await SignUpPage({ params: Promise.resolve({ locale: 'he' }) })).toBeTruthy();
  });
});
