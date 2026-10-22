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

describe('⚠ the inbox views do not prefetch (dev, 2026-10-11)', () => {
  it('★ a view link is not prefetched - each would render the inbox on the server', () => {
    show({ totals: { queue: 3 } });
    const viewLinks = screen
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').includes('view='));
    expect(viewLinks.length).toBeGreaterThan(1);
    for (const link of viewLinks) expect(link).toHaveAttribute('data-prefetch', 'false');
  });
});

describe('★★ the rail says each view’s size - and no unread pill (Omer, 2026-10-11)', () => {
  /*
   * "Now there's both what I wanted AND the circles with numbers - remove
   * them." The rail is the view's size; unread is the list's, on each row.
   */
  const total = (view: string) => screen.queryByTestId(`rail-total-${view}`);

  it('★★ the live answer (Backend a3d07d09): every size drawn, no pill anywhere', () => {
    show({ totals: { queue: 0, mine: 3, active: 2, gotcha: 11, all: 90 } });
    expect(total('queue')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^0$/);
    expect(total('gotcha')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^11$/);
    expect(document.querySelector('[data-testid^="rail-unread-"]')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Assigned to me 3 conversations' }),
    ).toBeInTheDocument();
    // Resolved is not asked for, so it has no size to draw.
    expect(total('resolved')).toBeNull();
  });

  it('★★ "Resolved" draws no size even when the page sends one (Omer, 2026-10-12)', () => {
    // The inbox asks for every view, resolved included; the rail leaves it bare.
    show({ totals: { queue: 4, mine: 3, active: 2, gotcha: 11, resolved: 812 } });
    expect(total('resolved')).toBeNull();
    expect(screen.getByRole('link', { name: 'Resolved' })).toBeInTheDocument();
    for (const view of ['queue', 'mine', 'active', 'gotcha']) {
      expect(total(view), view).toBeInTheDocument();
    }
  });

  it('★★ drawn with the muted counter class', () => {
    show({ totals: { queue: 2, mine: 5 } });
    expect(total('queue')).toHaveClass(styles.subNavCount!);
    expect(total('mine')!.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^5$/);
  });

  it('★ a real 0 is drawn: it is the view’s size, an empty queue', () => {
    show({ totals: { queue: 0 } });
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^0 conversations$/);
  });

  it('⚠⚠ no totals (an old backend) or a failed read (null) draw nothing - never a 0', () => {
    show({ totals: {} });
    expect(document.querySelector('[data-testid^="rail-total-"]')).toBeNull();
    show(null);
    expect(document.querySelector('[data-testid^="rail-total-"]')).toBeNull();
  });

  it('⚠ the page going takes its counts with it', () => {
    const { rerender } = show({ totals: { queue: 2 } });
    expect(total('queue')).toBeInTheDocument();
    act(() => {
      rerender(
        <NextIntlClientProvider locale="en" messages={{ navigation }}>
          <PrimaryNavigation />
        </NextIntlClientProvider>,
      );
    });
    expect(total('queue')).toBeNull();
  });

  it('★ the name is its own item, so it can give way beside the number', () => {
    show({ totals: { queue: 2 } });
    const link = screen.getByRole('link', { name: 'Waiting in queue 2 conversations' });
    expect(link.firstElementChild).toHaveClass(styles.subNavText!);
    expect(link.firstElementChild).toHaveTextContent(/^Waiting in queue$/);
  });

  it('★ in English, with its plural', () => {
    show({ totals: { queue: 1, mine: 5 } });
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^1 conversation$/);
    expect(total('mine')!.querySelector('.srOnly')).toHaveTextContent(/^5 conversations$/);
  });

  it('★ in Hebrew, with its plural', () => {
    show({ totals: { queue: 1, mine: 5, active: 0 } }, 'he');
    expect(total('queue')!.querySelector('.srOnly')).toHaveTextContent(/^שיחה אחת$/);
    expect(total('mine')!.querySelector('.srOnly')).toHaveTextContent(/^5 שיחות$/);
    expect(total('active')!.querySelector('.srOnly')).toHaveTextContent(/^0 שיחות$/);
    expect(total('mine')!.querySelector('[aria-hidden="true"]')).toHaveAttribute('dir', 'ltr');
  });

  it('★★ the rule: plain text in a frame text token - no fill, no shape, no wrap; no pill style left', () => {
    const css = readFileSync('src/shell/AppShell.module.css', 'utf8');
    const start = css.indexOf('.subNavCount {');
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toMatch(/background/);
    expect(rule).not.toMatch(/border-radius/);
    expect(rule).toMatch(/^\s*color: var\(--frame-text-(muted|faint|secondary)\);$/m);
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('flex: none');
    const text = css.slice(
      css.indexOf('.subNavText {'),
      css.indexOf('}', css.indexOf('.subNavText {')),
    );
    expect(text).toContain('min-inline-size: 0');
    expect(text).toContain('text-overflow: ellipsis');
    // ★ one line at every desktop width: it gives way, it never wraps
    expect(text).toContain('white-space: nowrap');
    expect(css).not.toContain('.subNavUnread');
    // A view row with its size ends tighter, so "Handled by GOTCHA 11" fits whole
    // at the narrowest desktop rail (measured in Chromium, 2026-10-11).
    expect(css).toMatch(
      /\.subNavLink:has\(> \.subNavCount\) \{\s*padding-inline-end: var\(--space-8\);/,
    );
  });
});
