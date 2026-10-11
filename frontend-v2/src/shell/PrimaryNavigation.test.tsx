import { readFileSync } from 'node:fs';

import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';
import heNavigation from '@/i18n/messages/he/navigation.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('view=queue') }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/inbox',
  Link: ({
    href,
    children,
    prefetch,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean | null;
  }) => (
    <a href={href} data-prefetch={prefetch === undefined ? 'default' : String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/permissions/permissions-context', () => ({
  usePermissions: () => ({ canSee: () => true }),
}));

import styles from './AppShell.module.css';
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

describe('★★ unread is a pill, never a number in the size slot (supervisor, 2026-10-11)', () => {
  it('★★ drawn as the pill, not as the plain muted count', () => {
    show({ queue: 3 });
    const pill = screen.getByTestId('rail-unread-queue');
    expect(pill).toHaveClass(styles.subNavUnread!);
    expect(pill).not.toHaveClass(styles.subNavCount!);
  });

  it('★ past 99 it says "99+", kept left-to-right', () => {
    show({ queue: 140 });
    const shown = screen.getByTestId('rail-unread-queue').querySelector('[aria-hidden="true"]');
    expect(shown).toHaveTextContent(/^99\+$/);
    expect(shown).toHaveAttribute('dir', 'ltr');
    // the screen reader still hears the real number
    expect(screen.getByTestId('rail-unread-queue')).toHaveTextContent('140 unread conversations');
  });

  it('★ the row pill’s geometry, inked light on the dark rail', () => {
    const css = readFileSync('src/shell/AppShell.module.css', 'utf8');
    const rule = css.slice(
      css.indexOf('.subNavUnread {'),
      css.indexOf('}', css.indexOf('.subNavUnread {')),
    );
    expect(rule).toContain('block-size: var(--space-18)');
    expect(rule).toContain('min-inline-size: var(--space-18)');
    expect(rule).toContain('border-radius: var(--radius-item)');
    expect(rule).toContain('background-color: var(--frame-text)');
    expect(rule).toContain('color: var(--frame-base)');
  });
});

describe('⚠ the inbox views do not prefetch (dev, 2026-10-11)', () => {
  it('★ a view link is not prefetched - each would render the inbox on the server', () => {
    show({ queue: 3 });
    const viewLinks = screen
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').includes('view='));
    expect(viewLinks.length).toBeGreaterThan(1);
    for (const link of viewLinks) expect(link).toHaveAttribute('data-prefetch', 'false');
  });
});
