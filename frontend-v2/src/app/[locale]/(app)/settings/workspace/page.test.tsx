import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import workspace from '@/i18n/messages/en/workspace.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'workspace') =>
    createTranslator({ locale: 'en', messages: { workspace }, namespace }),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/shell/Drawer', () => ({
  Drawer: ({ testId, title, children }: { testId: string; title: string; children: ReactNode }) => (
    <aside data-testid={testId} aria-label={title}>
      {children}
    </aside>
  ),
}));
const { stub } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
}));
vi.mock('@/features/workspace/FactRows', () => ({ FactRows: stub('facts') }));
vi.mock('@/features/workspace/ScanPanel', () => ({ ScanPanel: stub('scan') }));
vi.mock('@/features/workspace/VoiceEditor', () => ({ VoiceEditor: stub('voice') }));
vi.mock('@/features/workspace/ProhibitedClaims', () => ({ ProhibitedClaims: stub('claims') }));
vi.mock('@/features/workspace/BusinessDrawer', () => ({ BusinessDrawer: stub('business') }));
vi.mock('@/features/workspace/HoursDrawer', () => ({ HoursDrawer: stub('hours') }));
vi.mock('@/features/workspace/LanguageDrawer', () => ({ LanguageDrawer: stub('language') }));
vi.mock('@/features/workspace/load-workspace', () => ({
  loadWebsiteScan: async () => null,
  loadWorkspace: async () => ({
    workspace: { name: 'Urban Supply', languages: ['he'] },
    voice: null,
    claims: null,
  }),
}));
vi.mock('@/features/workspace/load-languages', () => ({
  loadLanguages: async () => ({ share: null, systemLocale: 'he', myLocale: 'en' }),
}));

import Page from './page';

const open = async (panel?: string) =>
  render(await Page({ searchParams: Promise.resolve(panel ? { panel } : {}) }));

describe('★ 11 - 11b, 11c and 11d open over it', () => {
  it('11 alone: no drawer', async () => {
    await open();
    expect(screen.getByTestId('facts')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it.each([
    ['business', 'drawer-business', 'business', 'Business & website'],
    ['hours', 'drawer-hours', 'hours', 'Opening hours'],
    ['language', 'drawer-language', 'language', 'Language'],
  ])('?panel=%s opens %s, titled as 02', async (panel, drawer, inside, title) => {
    await open(panel);
    expect(screen.getByTestId(drawer)).toHaveAttribute('aria-label', title);
    expect(screen.getByTestId(inside)).toBeInTheDocument();
  });
});
