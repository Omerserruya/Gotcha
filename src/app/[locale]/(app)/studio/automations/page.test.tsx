import { render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/automations.json';
import { PermissionsProvider } from '@/permissions/permissions-context';

const loadAutomations = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
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
vi.mock('@/features/automations/NewAutomation', () => ({
  NewAutomation: () => <div data-testid="sheet" />,
}));

const { default: Page, ListSection } = await import('./page');

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
    const card = screen.getByTestId('automations-template-cart');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).toHaveTextContent('Coming soon');
    expect(card).toHaveTextContent('Needs cart events from your store');
    expect(card.querySelector('a, button')).toBeNull();
  });

  it('a template chosen opens the sheet - only for one that can run', async () => {
    loadAutomations.mockResolvedValue([]);
    const { templateOf } = await import('@/features/automations/templates');
    const one = wrap(await ListSection({ creating: false, fromTemplate: templateOf('welcome') }));
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    one.unmount();
    wrap(await ListSection({ creating: false, fromTemplate: null }));
    expect(screen.queryByTestId('sheet')).toBeNull();
  });
});
