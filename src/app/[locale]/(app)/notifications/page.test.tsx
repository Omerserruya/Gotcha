import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ redirect }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'he' }));

describe('★ 01d — the old page lands on the panel', () => {
  it('redirects to Home with the panel open, in the reader’s locale', async () => {
    const { default: Page } = await import('./page');
    await Page();
    expect(redirect).toHaveBeenCalledWith({
      href: { pathname: '/home', query: { notifications: '1' } },
      locale: 'he',
    });
  });
});
