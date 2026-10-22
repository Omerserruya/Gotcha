import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';
import messages from '@/i18n/messages/en/notifications-settings.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { 'notifications-settings': messages, navigation },
      namespace: namespace as 'navigation',
    }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({
    title,
    back,
    children,
  }: {
    title: string;
    back?: { href: string; label: string };
    children: ReactNode;
  }) => (
    <div>
      {back ? (
        <a data-testid="back" href={back.href}>
          ← {back.label}
        </a>
      ) : null}
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock('@/features/notifications-settings/PreferenceMatrix', () => ({
  PreferenceMatrix: () => <div data-testid="matrix" />,
}));
vi.mock('@/features/notifications-settings/RuleTable', () => ({
  RuleTable: () => <div data-testid="rules" />,
}));
vi.mock('@/features/notifications-settings/load-preferences', () => ({
  loadPreferences: async () => ({ preferences: null, volume: null, whatsappDestination: null }),
}));
vi.mock('@/features/notifications-settings/load-rules', () => ({
  loadRules: async () => ({ rules: [], departments: [], members: [] }),
}));

import Page from './page';
import RulesPage from './rules/page';

describe('★ 15 is the design’s page; the rules are their own', () => {
  it('15 draws the matrix and not the rule table', async () => {
    render(await Page());
    expect(screen.getByTestId('matrix')).toBeInTheDocument();
    expect(screen.queryByTestId('rules')).toBeNull();
  });

  it('the rules page has the table and "← Notifications" above its title', async () => {
    render(await RulesPage());
    expect(screen.getByTestId('rules')).toBeInTheDocument();
    expect(screen.getByTestId('back')).toHaveAttribute('href', '/settings/notifications');
    expect(screen.getByTestId('back')).toHaveTextContent('← Notifications');
  });
});
