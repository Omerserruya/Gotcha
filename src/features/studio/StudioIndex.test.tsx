import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/*
 * The localised `Link` reaches for `next/navigation`, which this environment
 * cannot resolve. Mocked to a plain anchor, as the other tests of linked
 * components do — the locale prefix is `@/i18n/navigation`'s business and
 * asserting it here would test the mock.
 */
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PermissionsProvider } from '@/permissions/permissions-context';
import automations from '@/i18n/messages/en/automations.json';
import capabilities from '@/i18n/messages/en/capabilities.json';
import employees from '@/i18n/messages/en/employees.json';
import knowledge from '@/i18n/messages/en/knowledge.json';
import studio from '@/i18n/messages/en/studio.json';
import { StudioIndex } from './StudioIndex';

/**
 * Studio's index — the one route a walk of all 27 screens reported as empty.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INDEX BORROWS EVERY WORD, AND THAT IS THE PROPERTY UNDER TEST
 * ════════════════════════════════════════════════════════════════════════════
 * Each card shows the destination screen's OWN title and description. A summary
 * written here would be a second vocabulary for the same four things, and the day
 * somebody rewrote the Knowledge screen this index would keep describing the old
 * one. So the assertions read the strings out of the OTHER namespaces' catalogues
 * rather than hard-coding them — a test that pinned the words would recreate the
 * drift it exists to prevent.
 */

/*
 * The real list, copied rather than imported: a test file is also `features` and
 * may not reach into `shell`. Copying it would normally be a drift hazard, so the
 * last test in this file asserts the two are the same.
 */
const STUDIO_SECTIONS = [
  { id: 'employees', href: '/studio/employees', permission: 'ai:employees:read' },
  { id: 'knowledge', href: '/studio/knowledge', permission: 'ai:knowledge:read' },
  { id: 'automations', href: '/studio/automations', permission: 'ai:workflows:read' },
  { id: 'capabilities', href: '/studio/capabilities', permission: 'ai:tools:read' },
] as const;

const ALL = [
  'ai:employees:read',
  'ai:knowledge:read',
  'ai:workflows:read',
  'ai:tools:read',
] as const;

const show = (permissions: readonly string[], status: 'loaded' | 'unavailable' = 'loaded') =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={{ studio, employees, knowledge, automations, capabilities }}
    >
      <PermissionsProvider permissions={permissions as never} status={status} tenantId="t1">
        <StudioIndex areas={STUDIO_SECTIONS} />
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );

describe('★★ the index lists what exists, in each area’s own words', () => {
  it('★★ shows a card per area, using that area’s own title and description', async () => {
    show(ALL);
    // Read from the destination catalogues, not written here.
    expect(screen.getByTestId('studio-area-knowledge')).toHaveTextContent(knowledge.title);
    expect(screen.getByTestId('studio-area-knowledge')).toHaveTextContent(knowledge.description);
    expect(screen.getByTestId('studio-area-employees')).toHaveTextContent(employees.title);
    expect(screen.getByTestId('studio-area-automations')).toHaveTextContent(automations.title);
    expect(screen.getByTestId('studio-area-capabilities')).toHaveTextContent(capabilities.title);
  });

  it('★★ lists every navigable section, so a fifth area cannot be forgotten', async () => {
    /*
     * Built from `STUDIO_SECTIONS`, which is what the sidebar renders. This
     * asserts the relationship rather than the number four — a test expecting
     * four cards would go red when somebody adds an area, which teaches them to
     * edit the test instead of noticing the index already handled it.
     */
    show(ALL);
    const navigable = STUDIO_SECTIONS.filter((s) => s.href !== undefined);
    expect(screen.getAllByTestId(/^studio-area-/)).toHaveLength(navigable.length);
  });

  it('★★ links to the section’s own href', async () => {
    show(ALL);
    for (const section of STUDIO_SECTIONS.filter((s) => s.href !== undefined)) {
      expect(screen.getByTestId(`studio-area-${section.id}`)).toHaveAttribute(
        'href',
        section.href!,
      );
    }
  });
});

describe('★★ permissions, and the state where a role has none of them', () => {
  it('hides an area the role cannot open', async () => {
    show(['ai:knowledge:read']);
    expect(screen.getByTestId('studio-area-knowledge')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-area-employees')).toBeNull();
  });

  it('★★ says so when the role has none of the four, rather than rendering nothing', async () => {
    /*
     * Every area is gated, so this is a real state and not a defensive branch.
     * An empty page here is indistinguishable from something failing to load —
     * which is the mistake that hid a wrong URL on Security for six capture runs.
     */
    show([]);
    expect(screen.getByTestId('studio-none')).toBeInTheDocument();
    expect(screen.queryByTestId('studio-index')).toBeNull();
  });

  it('★★ shows everything when the permission set could not be read', async () => {
    /*
     * `canSee` returns true on `unavailable`, deliberately: a product that appears
     * to have vanished is worse than a link to a page that explains the refusal.
     * Asserted here because the index is the screen where "hidden" and "does not
     * exist" look identical.
     */
    show([], 'unavailable');
    expect(screen.getAllByTestId(/^studio-area-/)).toHaveLength(
      STUDIO_SECTIONS.filter((s) => s.href !== undefined).length,
    );
  });
});

describe('★★ the copied list has not drifted from the real one', () => {
  it('★★ matches `STUDIO_SECTIONS` in the shell, id for id', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE GUARD ON THE COPY, AND IT IS HERE BECAUSE I CLAIMED IT IN A COMMENT
     * ════════════════════════════════════════════════════════════════════════
     * This file cannot import `@/shell/navigation` — a test file is `features`
     * and the boundary forbids it — so the list above is a copy, and a copy
     * drifts. The comment beside it says the two are asserted to be the same,
     * and a comment claiming a check that does not exist is the exact defect I
     * fixed twice today in other people's words and my own.
     *
     * So it reads the shell's source as text. That is a blunt instrument and its
     * blind spot is stated: it compares IDS and nothing else, so a changed
     * `href` or `permission` passes. Ids are what the index keys on and what a
     * fifth area would add, which is the drift that matters here.
     */
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(process.cwd(), 'src/shell/navigation.ts'), 'utf8');

    const block = source.slice(
      source.indexOf('export const STUDIO_SECTIONS'),
      source.indexOf('/**', source.indexOf('export const STUDIO_SECTIONS') + 1),
    );
    /* A path that resolves to nothing makes this pass for ever. */
    expect(block.length).toBeGreaterThan(100);

    const ids = [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(STUDIO_SECTIONS.map((section) => section.id));
  });
});
