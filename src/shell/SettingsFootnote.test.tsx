import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';

const pathname = vi.hoisted(() => ({ current: '/settings/workspace' }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => pathname.current,
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { SettingsFootnote } from './SettingsFootnote';

const show = (path: string) => {
  pathname.current = path;
  return render(
    <NextIntlClientProvider locale="en" messages={{ navigation }}>
      <SettingsFootnote />
    </NextIntlClientProvider>,
  );
};

describe('★ the footnote is 11’s, not every screen’s', () => {
  it('on Workspace: "How GOTCHA behaves lives in Studio", Studio a link', () => {
    show('/settings/workspace');
    expect(screen.getByRole('link', { name: 'Studio' })).toHaveAttribute('href', '/studio');
  });

  it('★ on 12–18: nothing — 02 draws no footnote there', () => {
    for (const path of ['/settings/people', '/settings/billing/plan', '/settings/developer']) {
      const { container, unmount } = show(path);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
