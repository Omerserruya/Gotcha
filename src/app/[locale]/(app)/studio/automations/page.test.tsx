import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/automations.json';

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
  PageContainer: ({ actions, children }: { actions: ReactNode; children: ReactNode }) => (
    <div>
      <header>{actions}</header>
      {children}
    </div>
  ),
}));
vi.mock('@/features/automations/AutomationsList', () => ({ AutomationsList: () => null }));
vi.mock('@/features/automations/NewAutomation', () => ({
  NewAutomation: () => <div data-testid="sheet" />,
}));

const { default: Page } = await import('./page');

describe('★ without ai:workflows:read (Backend 5: 403 PERMISSION_DENIED)', () => {
  it('a direct link says "no access" - not an error, and offers nothing to create', async () => {
    loadAutomations.mockResolvedValue('forbidden');
    render(await Page({ searchParams: Promise.resolve({ new: '1' }) }));
    expect(screen.getByTestId('automations-forbidden')).toHaveTextContent(
      "You don't have access to automations",
    );
    expect(screen.queryByTestId('automations-unread')).toBeNull();
    expect(screen.queryByTestId('automations-new')).toBeNull();
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('unread is still "couldn\'t read", with New automation there', async () => {
    loadAutomations.mockResolvedValue(null);
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByTestId('automations-unread')).toBeInTheDocument();
    expect(screen.getByTestId('automations-new')).toBeInTheDocument();
  });
});

describe('★★ templates: real ones open New automation; the rest are a status, not an action', () => {
  it('a real template is a link to New automation, prefilled', async () => {
    loadAutomations.mockResolvedValue([]);
    render(await Page({ searchParams: Promise.resolve({}) }));
    const card = screen.getByTestId('automations-template-welcome');
    expect(card.tagName).toBe('A');
    expect(card.getAttribute('href')).toContain('"template":"welcome"');
  });

  it('one with no event source: Coming soon, aria-disabled, not a link, says why', async () => {
    loadAutomations.mockResolvedValue([]);
    render(await Page({ searchParams: Promise.resolve({}) }));
    const card = screen.getByTestId('automations-template-cart');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).toHaveTextContent('Coming soon');
    expect(card).toHaveTextContent('Needs cart events from your store');
    expect(card.querySelector('a, button')).toBeNull();
  });

  it('?template= opens the sheet for a real one - never for one that cannot run', async () => {
    loadAutomations.mockResolvedValue([]);
    const one = render(await Page({ searchParams: Promise.resolve({ template: 'welcome' }) }));
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    one.unmount();
    render(await Page({ searchParams: Promise.resolve({ template: 'cart' }) }));
    expect(screen.queryByTestId('sheet')).toBeNull();
  });
});
