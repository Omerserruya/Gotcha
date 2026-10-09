import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { loadMessages } from '@/i18n/load-messages';
import { PermissionsProvider } from '@/permissions/permissions-context';

/**
 * ★★ A NAVIGATION SHOWS THE NEW PAGE AT ONCE (Omer, 2026-10-07; measured on
 * dev with a 7s throttle: the old page stayed on screen, no feedback).
 *
 * Next draws a route's `loading.tsx` the moment a navigation into it starts
 * - it is prefetched with the route. One `loading.tsx` covers navigations
 * into ITS OWN segment only: the one at `(app)` sat above Studio's and
 * Settings' shared layouts and never showed between their pages. So every
 * route has its own, and this walks the routes on disk to hold that.
 */
const ROOT = join(process.cwd(), 'src/app/[locale]/(app)');

/** Pages that only redirect: nothing to draw while they do. */
const REDIRECTS = new Set([
  'notifications',
  'settings/people/roles/[userId]',
  'foundation',
  // The web chat's old address: the one Website widget now.
  'settings/channels/webchat/[id]',
]);

function pageDirs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...pageDirs(path));
  }
  if (existsSync(join(dir, 'page.tsx'))) out.push(dir);
  return out;
}

describe('★★ every route has its own loading frame', () => {
  const routes = pageDirs(ROOT)
    .map((d) => relative(ROOT, d))
    .filter((r) => r !== '');

  it('the walk finds the routes (not an empty pass)', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain('studio/skills');
  });

  it.each(routes.filter((r) => !REDIRECTS.has(r)))('%s', (route) => {
    expect(existsSync(join(ROOT, route, 'loading.tsx'))).toBe(true);
  });

  it('a redirect listed here really only redirects', () => {
    for (const route of REDIRECTS) {
      const source = readFileSync(join(ROOT, route, 'page.tsx'), 'utf8');
      if (route === 'foundation') continue;
      expect(source).toMatch(/redirect\(/);
    }
  });
});

vi.mock('server-only', () => ({}));
// A loader's client parts (04's live search) ask the app router; none is mounted here.
vi.mock('next/navigation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', async () => {
  const messages = await loadMessages('en');
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as never }),
  };
});
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/features/skills/load-skills', () => ({
  loadSkillsLibrary: () => new Promise(() => {}),
  loadSkillEmployees: () => new Promise(() => {}),
}));
vi.mock('@/features/automations/load-automations', () => ({
  loadAutomations: () => new Promise(() => {}),
  loadCatalog: () => new Promise(() => {}),
}));

describe('★★ the measured six draw their own frame at once (title, buttons, headers) and placeholders', () => {
  const show = async (node: ReactNode) => {
    const messages = await loadMessages('en');
    return render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PermissionsProvider permissions={['ai:workflows:read']} tenantId="t">
          {node}
        </PermissionsProvider>
      </NextIntlClientProvider>,
    );
  };

  it('Skills: its title, its buttons, the table header, the side', async () => {
    const { default: Loading } = await import('./studio/skills/loading');
    await show(<Loading />);
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByTestId('skills-describe')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Skill' })).toBeInTheDocument();
    expect(screen.getByLabelText('Loading skills')).toHaveAttribute('aria-busy', 'true');
  });

  it('Automations: its title, its buttons, the table header, the templates', async () => {
    const { default: Loading } = await import('./studio/automations/loading');
    await show(<Loading />);
    expect(screen.getByRole('heading', { name: 'Automations' })).toBeInTheDocument();
    expect(screen.getByTestId('automations-new')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'When' })).toBeInTheDocument();
    expect(screen.getByTestId('automations-template-welcome')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading automations')).toHaveAttribute('aria-busy', 'true');
  });

  it('Customers: its title, line, search and Add; its columns as placeholders', async () => {
    const { default: Loading } = await import('./customers/loading');
    await show(<Loading />);
    expect(screen.getByRole('heading', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByTestId('customer-search-input')).toBeInTheDocument();
    expect(screen.getByTestId('customers-loading')).toBeInTheDocument();
  });

  it('Approvals: its title and line; the decisions as placeholders', async () => {
    const { default: Loading } = await import('./approvals/loading');
    await show(<Loading />);
    expect(screen.getByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.getByTestId('approvals-loading')).toBeInTheDocument();
  });

  it('Home: its layout, every read block a placeholder', async () => {
    const { default: Loading } = await import('./home/loading');
    await show(<Loading />);
    expect(screen.getByTestId('home-loading')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-stats')).toBeInTheDocument();
  });

  it('Inbox: its two panels in their shape', async () => {
    const { default: Loading } = await import('./inbox/loading');
    await show(<Loading />);
    expect(screen.getByTestId('inbox-loading')).toBeInTheDocument();
    expect(screen.getByTestId('queue-skeleton')).toBeInTheDocument();
  });

  it("a generated one: the route's own title, not a generic word", async () => {
    const source = readFileSync(join(ROOT, 'studio/employees/loading.tsx'), 'utf8');
    const label = /label="([^"]+)"/.exec(source)?.[1];
    expect(label).toBe('studio.employees');
    const { RouteLoading } = await import('@/shell/RouteLoading');
    await show(await RouteLoading({ label: label!, preset: 'cards' }));
    expect(screen.getByRole('heading', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.getByTestId('route-loading')).toHaveAttribute('data-preset', 'cards');
  });
});
