import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/automations.json';
import { PermissionsProvider } from '@/permissions/permissions-context';

const loadAutomations = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
const rejected = vi.hoisted(() => ({ value: false }));
vi.mock('@/api/client/session-rejected', () => ({ sessionRejected: () => rejected.value }));
vi.mock('@/features/automations/load-automations', () => ({
  loadAutomations,
  loadCatalog: async () => null,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { automations: messages },
      namespace: namespace as never,
    }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/shell/PageContainer', () => ({
  PageContainer: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <header>{actions}</header>
      {children}
    </div>
  ),
}));
const sheetProps = vi.hoisted(() => [] as unknown[]);
vi.mock('@/features/automations/NewAutomation', () => ({
  NewAutomation: (props: unknown) => {
    sheetProps.push(props);
    return <div data-testid="sheet" />;
  },
}));

const { default: Page } = await import('./page');
const { ListSection } = await import('@/features/automations/AutomationsPage');
const { TEMPLATES } = await import('@/features/automations/templates');

/**
 * Where a value would stop React sending it to a client component: a
 * function (or a symbol, a class instance) anywhere in it. `null`: it can go.
 */
function unsendable(value: unknown, at = 'props'): string | null {
  if (typeof value === 'function' || typeof value === 'symbol') return at;
  if (value === null || typeof value !== 'object') return null;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return at;
  for (const [k, v] of Object.entries(value)) {
    const found = unsendable(v, `${at}.${k}`);
    if (found) return found;
  }
  return null;
}

/** The element in a server component's returned tree whose type is `type`. */
function find(node: unknown, type: unknown): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return el as { props: Record<string, unknown> };
  return find(el.props?.children, type);
}

const wrap = (node: ReactNode, permissions: string[] = ['ai:workflows:read']) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ automations: messages }}>
      <PermissionsProvider permissions={permissions} tenantId="t1">
        {node}
      </PermissionsProvider>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  loadAutomations.mockReset();
  sheetProps.length = 0;
  rejected.value = false;
});

describe('★★ placeholders, not a blank page (Omer, 2026-10-07)', () => {
  it('the title, the buttons, the table header and the templates draw while the list is read', async () => {
    loadAutomations.mockReturnValue(new Promise(() => {}));
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Automations')).toBeInTheDocument();
    expect(screen.getByTestId('automations-new')).toBeInTheDocument();
    expect(screen.getByTestId('automations-template-welcome')).toBeInTheDocument();
    expect(await screen.findByTestId('automations-pending')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'When' })).toBeInTheDocument();
    expect(screen.getByLabelText('Loading automations')).toHaveAttribute('aria-busy', 'true');
  });

  it('without ai:workflows:read the static offers are not drawn at all', async () => {
    loadAutomations.mockReturnValue(new Promise(() => {}));
    wrap(await Page({ searchParams: Promise.resolve({}) }), []);
    expect(screen.queryByTestId('automations-new')).toBeNull();
    expect(screen.queryByTestId('automations-template-welcome')).toBeNull();
  });
});

describe('★ without ai:workflows:read (Backend 5: 403 PERMISSION_DENIED)', () => {
  it('a direct link says "no access" - not an error, and opens nothing', async () => {
    loadAutomations.mockResolvedValue('forbidden');
    wrap(await ListSection({ creating: true, fromTemplate: null }));
    expect(screen.getByTestId('automations-forbidden')).toHaveTextContent(
      "You don't have access to automations",
    );
    expect(screen.queryByTestId('automations-unread')).toBeNull();
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('★★ refused as signed out during this render: sign-in, not "couldn\'t read"', async () => {
    loadAutomations.mockResolvedValue(null);
    rejected.value = true;
    wrap(await ListSection({ creating: false, fromTemplate: null }));
    expect(screen.getByTestId('session-ended')).toBeInTheDocument();
    expect(screen.queryByTestId('automations-unread')).toBeNull();
  });

  it('unread is still "couldn\'t read"', async () => {
    loadAutomations.mockResolvedValue(null);
    wrap(await ListSection({ creating: false, fromTemplate: null }));
    expect(screen.getByTestId('automations-unread')).toBeInTheDocument();
  });
});

describe('★★ templates: real ones open New automation; the rest are a status, not an action', () => {
  it('a real template is a link to New automation, prefilled', async () => {
    loadAutomations.mockReturnValue(new Promise(() => {}));
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    const card = screen.getByTestId('automations-template-welcome');
    expect(card.tagName).toBe('A');
    expect(card.getAttribute('href')).toContain('"template":"welcome"');
  });

  it('one with no event source: Coming soon, aria-disabled, not a link, says why', async () => {
    loadAutomations.mockReturnValue(new Promise(() => {}));
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    const card = screen.getByTestId('automations-template-comment');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).toHaveTextContent('Coming soon');
    expect(card).toHaveTextContent('Needs comment events from Instagram and Facebook');
    expect(card.querySelector('a, button')).toBeNull();
  });

  it('a template chosen opens the sheet - only for one that can run', async () => {
    loadAutomations.mockResolvedValue([]);
    const one = wrap(await ListSection({ creating: false, fromTemplate: 'welcome' }));
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    one.unmount();
    wrap(await ListSection({ creating: false, fromTemplate: null }));
    expect(screen.queryByTestId('sheet')).toBeNull();
  });
});

describe('★★ ?template= reaches the client as data only (dev, 8df59dd: a function crashed it)', () => {
  /*
   * The defect was invisible to every render test: React only refuses a
   * function where a server component's props are SERIALISED for a client
   * one. So this walks the route the way the server does - the page, then
   * its list section - and checks what the client sheet is handed.
   */
  it.each(TEMPLATES.filter((t) => t.build).map((t) => t.key))(
    '%s: the sheet opens, and nothing it is given is a function',
    async (key) => {
      loadAutomations.mockResolvedValue([]);
      const tree = await Page({ searchParams: Promise.resolve({ template: key }) });
      const section = find(tree, ListSection);
      expect(section).not.toBeNull();
      wrap(await ListSection(section!.props as Parameters<typeof ListSection>[0]));
      expect(screen.getByTestId('sheet')).toBeInTheDocument();
      expect(sheetProps).toHaveLength(1);
      expect(unsendable(sheetProps[0])).toBeNull();
    },
  );

  it('the check itself sees a function', () => {
    expect(unsendable({ templateKey: 'cart', template: { build: () => null } })).toBe(
      'props.template.build',
    );
  });
});
