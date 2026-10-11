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

/** Counts as an old backend sends them: unread per view, no `totals`. */
const unreadOnly = (unread: RailCounts['unread']): RailCounts => ({ unread, totals: {} });

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
    show(unreadOnly({ queue: 3, mine: 1 }));
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
    show(unreadOnly({ queue: 0 }));
    expect(document.querySelector('[data-testid^="rail-unread-"]')).toBeNull();
  });

  it('★ in Hebrew, with its plural', () => {
    show(unreadOnly({ queue: 1, active: 4 }), 'he');
    expect(screen.getByTestId('rail-unread-queue')).toHaveTextContent('שיחה אחת שלא נקראה');
    expect(screen.getByTestId('rail-unread-active')).toHaveTextContent('4 שיחות שלא נקראו');
  });

  it('⚠ the page going takes its counts with it', () => {
    const { rerender } = show(unreadOnly({ queue: 2 }));
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
    show(unreadOnly({ queue: 3 }));
    const pill = screen.getByTestId('rail-unread-queue');
    expect(pill).toHaveClass(styles.subNavUnread!);
    expect(pill).not.toHaveClass(styles.subNavCount!);
  });

  it('★ past 99 it says "99+", kept left-to-right', () => {
    show(unreadOnly({ queue: 140 }));
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
    show(unreadOnly({ queue: 3 }));
    const viewLinks = screen
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').includes('view='));
    expect(viewLinks.length).toBeGreaterThan(1);
    for (const link of viewLinks) expect(link).toHaveAttribute('data-prefetch', 'false');
  });
});

describe('★★ each view’s size, a plain muted number before the pill (Omer, 2026-10-11)', () => {
  const total = (view: string) => screen.queryByTestId(`rail-total-${view}`);

  it('★★ drawn with the muted counter class, not the pill', () => {
    show({ unread: {}, totals: { queue: 2, mine: 5 } });
    expect(total('queue')).toHaveClass(styles.subNavCount!);
    expect(total('queue')).not.toHaveClass(styles.subNavUnread!);
    expect(total('queue')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^2$/);
    expect(total('mine')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^5$/);
  });

  it('★★ the live answer (Backend a3d07d09): queue 0 drawn with no pill, mine 3 beside its 1', () => {
    show({
      unread: { queue: 0, mine: 1, active: 1, gotcha: 1, all: 2 },
      totals: { queue: 0, mine: 3, active: 2, gotcha: 11, all: 90 },
    });
    expect(total('queue')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^0$/);
    expect(screen.queryByTestId('rail-unread-queue')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Assigned to me 3 conversations 1 unread conversation' }),
    ).toBeInTheDocument();
    expect(total('gotcha')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^11$/);
    // Resolved is not asked for, so it has no size to draw.
    expect(total('resolved')).toBeNull();
  });

  it('★ a real 0 is drawn: it is the view’s size, an empty queue', () => {
    show({ unread: {}, totals: { queue: 0 } });
    expect(total('queue')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^0$/);
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^0 conversations$/);
  });

  it('⚠⚠ no totals (an old backend) or no counts at all draw no total - never a 0', () => {
    show(unreadOnly({ queue: 2 }));
    expect(document.querySelector('[data-testid^="rail-total-"]')).toBeNull();
    expect(screen.getByTestId('rail-unread-queue')).toBeInTheDocument();
  });

  it('⚠ a failed read (null) draws neither number', () => {
    show(null);
    expect(document.querySelector('[data-testid^="rail-total-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="rail-unread-"]')).toBeNull();
  });

  it('★ the name is its own item, so it can shrink beside the numbers', () => {
    show({ unread: {}, totals: { queue: 2 } });
    const link = screen.getByRole('link', { name: 'Waiting in queue 2 conversations' });
    expect(link.firstElementChild).toHaveClass(styles.subNavText!);
    expect(link.firstElementChild).toHaveTextContent(/^Waiting in queue$/);
  });

  it('★★ the total, then the unread pill beside it when unread > 0', () => {
    show({ unread: { queue: 2, mine: 0 }, totals: { queue: 2, mine: 5 } });
    const queue = total('queue')!;
    expect(queue.nextElementSibling).toBe(screen.getByTestId('rail-unread-queue'));
    expect(screen.queryByTestId('rail-unread-mine')).toBeNull();
    expect(total('mine')).toBeInTheDocument();
  });

  it('★ the link is named with both numbers, each said as what it is', () => {
    show({ unread: { queue: 1 }, totals: { queue: 2 } });
    expect(
      screen.getByRole('link', {
        name: 'Waiting in queue 2 conversations 1 unread conversation',
      }),
    ).toBeInTheDocument();
  });

  it('★ in English, with its plural', () => {
    show({ unread: {}, totals: { queue: 1, mine: 5 } });
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^1 conversation$/);
    expect(total('mine')!.querySelector('.srOnly')).toHaveTextContent(/^5 conversations$/);
  });

  it('★ in Hebrew, with its plural', () => {
    show({ unread: {}, totals: { queue: 1, mine: 5, active: 0 } }, 'he');
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^שיחה אחת$/);
    expect(total('mine')!.querySelector('.srOnly')).toHaveTextContent(/^5 שיחות$/);
    expect(total('active')!.querySelector('.srOnly')).toHaveTextContent(/^0 שיחות$/);
    expect(total('mine')!.querySelector('[aria-hidden="true"]')).toHaveAttribute('dir', 'ltr');
  });

  it('★★ the rule: plain text in a frame text token - no fill, no shape, no wrap', () => {
    const css = readFileSync('src/shell/AppShell.module.css', 'utf8');
    const start = css.indexOf('.subNavCount {');
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toMatch(/background/);
    expect(rule).not.toMatch(/border-radius/);
    expect(rule).toMatch(/^\s*color: var\(--frame-text-(muted|faint|secondary)\);$/m);
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('flex: none');
    // the name may shrink below its longest word, so the numbers never leave the row
    const text = css.slice(
      css.indexOf('.subNavText {'),
      css.indexOf('}', css.indexOf('.subNavText {')),
    );
    expect(text).toContain('min-inline-size: 0');
    expect(text).toContain('text-overflow: ellipsis');
    // after the size, the pill keeps a small gap instead of an auto margin
    expect(css).toMatch(
      /\.subNavCount \+ \.subNavUnread \{\s*margin-inline-start: var\(--space-\d+\);/,
    );
  });
});
