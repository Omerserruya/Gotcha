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
  Link: ({ children, ...rest }: { children: ReactNode }) => <a {...rest}>{children}</a>,
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
