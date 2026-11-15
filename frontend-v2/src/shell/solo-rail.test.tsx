import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { railViews, SOLO_MERGED_VIEWS } from '@/features/inbox/inbox-views';
import navigation from '@/i18n/messages/en/navigation.json';
import { SoleHumanProvider } from '@/tenant/sole-human-context';

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search.value) }));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/inbox',
  Link: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/permissions/permissions-context', () => ({
  usePermissions: () => ({ canSee: () => true }),
}));

import { childrenFor, PRIMARY_NAVIGATION, viewInForce } from './navigation';
import { PrimaryNavigation } from './PrimaryNavigation';
import { destinations } from './command-palette-model';

const inbox = PRIMARY_NAVIGATION.find((item) => item.id === 'inbox')!;

const tree = (soleHuman: boolean) => (
  <NextIntlClientProvider locale="en" messages={{ navigation }}>
    <SoleHumanProvider soleHuman={soleHuman}>
      <PrimaryNavigation />
    </SoleHumanProvider>
  </NextIntlClientProvider>
);

beforeEach(() => {
  search.value = '';
});

describe('★★ one person, one view in the rail (Omer, 2026-11-15)', () => {
  it("★★ NO FLASH: the server's HTML already has one view, not three", () => {
    // The flag is a prop from the layout's own read; the first HTML is the answer.
    const html = renderToString(tree(true));
    expect(html).toContain('>Open<');
    for (const gone of ['Waiting in queue', 'Assigned to me', '>Active<']) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain('Handled by GOTCHA');
    expect(html).toContain('Resolved');
  });

  it("★★ a team's server HTML is today's five", () => {
    const html = renderToString(tree(false));
    for (const label of ['Waiting in queue', 'Assigned to me', '>Active<', 'Handled by GOTCHA']) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('>Open<');
  });

  it.each(['', 'view=queue', 'view=mine', 'view=active', 'view=open'])(
    '★ `%s` lights "Open" - what the page shows',
    (query) => {
      search.value = query;
      render(tree(true));
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('aria-current', 'page');
    },
  );

  it('★ `view=resolved` lights "Resolved", not "Open"', () => {
    search.value = 'view=resolved';
    render(tree(true));
    expect(screen.getByRole('link', { name: 'Resolved' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Open' })).not.toHaveAttribute('aria-current');
  });
});

describe("★ the shell's copy of the views is inbox-views' own (the shell may not import it)", () => {
  it("★★ the rail's children are `railViews`, for one person and for a team", () => {
    expect(childrenFor(inbox, true).map((c) => c.view)).toEqual(railViews(true));
    expect(childrenFor(inbox, false).map((c) => c.view)).toEqual(railViews(false));
  });

  it("★★ the merged views and the default are inbox-views'", () => {
    expect(inbox.solo?.merged).toEqual(SOLO_MERGED_VIEWS);
    expect(inbox.solo?.defaultView).toBe('open');
    for (const view of SOLO_MERGED_VIEWS) expect(viewInForce(inbox, view, true)).toBe('open');
    expect(viewInForce(inbox, null, true)).toBe('open');
    expect(viewInForce(inbox, 'queue', false)).toBe('queue');
    expect(viewInForce(inbox, null, false)).toBe('mine');
  });

  it('★ ⌘K offers "Open" for one person, and the three for a team', () => {
    const views = (solo: boolean) =>
      destinations(() => true, solo)
        .filter((d) => d.href.startsWith('/inbox?'))
        .map((d) => d.href);
    expect(views(true)).toEqual(['/inbox?view=open', '/inbox?view=gotcha', '/inbox?view=resolved']);
    expect(views(false)).toContain('/inbox?view=queue');
    expect(views(false)).not.toContain('/inbox?view=open');
  });
});
