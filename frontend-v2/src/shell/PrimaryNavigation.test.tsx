import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';
import heNavigation from '@/i18n/messages/he/navigation.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('view=queue') }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/inbox',
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/permissions/permissions-context', () => ({
  usePermissions: () => ({ canSee: () => true }),
}));

import { PrimaryNavigation } from './PrimaryNavigation';
import { PublishRailCounts, type RailCounts } from './rail-counts';

const show = (counts: RailCounts | null, locale: 'en' | 'he' = 'en') =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ navigation: locale === 'he' ? heNavigation : navigation }}
    >
      <PrimaryNavigation />
      <PublishRailCounts counts={counts} />
    </NextIntlClientProvider>,
  );

describe('★★ the rail’s unread count per inbox view - only when a number came back', () => {
  it('★ a positive count beside its view, worded for a screen reader', () => {
    show({ queue: 3, mine: 1 });
    expect(screen.getByTestId('rail-unread-queue')).toHaveTextContent('3');
    expect(screen.getByTestId('rail-unread-queue').querySelector('.srOnly')).toHaveTextContent(
      /^3 unread conversations$/,
    );
    expect(screen.getByTestId('rail-unread-mine')).toHaveTextContent('1 unread conversation');
  });

  it('⚠⚠ no counts (a failed or absent read) draws nothing - never a 0', () => {
    show(null);
    expect(document.querySelector('[data-testid^="rail-unread-"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Waiting in queue' })).toBeInTheDocument();
  });

  it('⚠ a 0, or a view the route did not count, draws nothing', () => {
    show({ queue: 0 });
    expect(document.querySelector('[data-testid^="rail-unread-"]')).toBeNull();
  });

  it('★ in Hebrew, with its plural', () => {
    show({ queue: 1, active: 4 }, 'he');
    expect(screen.getByTestId('rail-unread-queue')).toHaveTextContent('שיחה אחת שלא נקראה');
    expect(screen.getByTestId('rail-unread-active')).toHaveTextContent('4 שיחות שלא נקראו');
  });

  it('⚠ the page going takes its counts with it', () => {
    const { rerender } = show({ queue: 2 });
    expect(screen.getByTestId('rail-unread-queue')).toBeInTheDocument();
    act(() => {
      rerender(
        <NextIntlClientProvider locale="en" messages={{ navigation }}>
          <PrimaryNavigation />
        </NextIntlClientProvider>,
      );
    });
    expect(screen.queryByTestId('rail-unread-queue')).toBeNull();
  });
});
