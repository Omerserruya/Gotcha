import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import navigation from '@/i18n/messages/en/navigation.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'navigation') =>
    createTranslator({ locale: 'en', messages: { navigation }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children, fill }: { children: ReactNode; fill?: boolean }) => (
    <div data-testid="settings-section" data-fill={fill ? 'yes' : 'no'}>
      {children}
    </div>
  ),
}));
vi.mock('@/features/developer/DeveloperScreen', () => ({
  DeveloperScreen: () => <div data-testid="developer" />,
}));

import Page from './page';

describe('★ 18 — the bottom row runs to the frame’s bottom', () => {
  it('the section fills, holding 02’s cards', async () => {
    render(await Page());
    expect(screen.getByTestId('settings-section')).toHaveAttribute('data-fill', 'yes');
    expect(screen.getByTestId('developer')).toBeInTheDocument();
  });
});
