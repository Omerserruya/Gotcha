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
const { stub, factRows } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
  factRows: vi.fn((_props: { scan?: unknown }) => <div data-testid="facts" />),
}));
vi.mock('@/features/workspace/FactRows', () => ({ FactRows: factRows }));
vi.mock('@/features/workspace/VoiceEditor', () => ({ VoiceEditor: stub('voice') }));
vi.mock('@/features/workspace/ProhibitedClaims', () => ({ ProhibitedClaims: stub('claims') }));
vi.mock('@/features/workspace/HoursDrawer', () => ({ HoursDrawer: stub('hours') }));
vi.mock('@/features/workspace/LanguageDrawer', () => ({ LanguageDrawer: stub('language') }));
vi.mock('@/features/workspace/load-workspace', () => ({
  loadWebsiteScan: async () => ({ pagesRead: 4, daysAgo: 1, topics: [], alsoFound: [] }),
  loadWorkspace: async () => ({
    workspace: { name: 'Urban Supply', languages: ['he'] },
    voice: null,
    claims: null,
  }),
}));
vi.mock('@/features/workspace/load-languages', () => ({
  loadLanguages: async () => ({ share: null, systemLocale: 'he' }),
}));

import Page from './page';

const open = async (panel?: string) =>
  render(await Page({ searchParams: Promise.resolve(panel ? { panel } : {}) }));

describe('★ 11 - 11c and 11d open over it', () => {
  it('11 alone: no drawer', async () => {
    await open();
    expect(screen.getByTestId('facts')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it.each([
    ['hours', 'drawer-hours', 'hours', 'Opening hours'],
    ['language', 'drawer-language', 'language', 'Language'],
  ])('?panel=%s opens %s, titled as 02', async (panel, drawer, inside, title) => {
    await open(panel);
    expect(screen.getByTestId(drawer)).toHaveAttribute('aria-label', title);
    expect(screen.getByTestId(inside)).toBeInTheDocument();
  });
});

describe('★ the business is one block on the page - no 11b drawer repeating it (Omer, 2026-10-11)', () => {
  it('?panel=business opens nothing: the rows edit in place', async () => {
    await open('business');
    expect(screen.getByTestId('facts')).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByTestId('drawer-business')).toBeNull();
  });

  it('the rows get what the scan read, for the website row', async () => {
    await open();
    expect(factRows.mock.calls.at(-1)?.[0].scan).toEqual({
      pagesRead: 4,
      daysAgo: 1,
      topics: [],
      alsoFound: [],
    });
  });

  it('the drawer’s own copy is gone from the catalogue', () => {
    for (const key of ['title', 'line', 'save', 'note', 'noNote', 'legend']) {
      expect(workspace.business).not.toHaveProperty(key);
    }
  });
});

describe('★ 11 - no "Scan again" here: it moved to Studio · Knowledge (Omer, 2026-10-11)', () => {
  it('the facts, the voice and the rules - and no scan banner, button or anchor', async () => {
    const { container } = await open();
    expect(screen.getByTestId('facts')).toBeInTheDocument();
    expect(screen.queryByTestId('scan')).toBeNull();
    expect(screen.queryByTestId('scan-run')).toBeNull();
    expect(screen.queryByTestId('scan-intro')).toBeNull();
    expect(container.querySelector('#scan')).toBeNull();
    expect(container).not.toHaveTextContent(/scan again/i);
  });

  it('its copy is not Workspace’s any more', () => {
    expect(workspace).not.toHaveProperty('scan');
    expect(workspace).not.toHaveProperty('intro');
  });
});
