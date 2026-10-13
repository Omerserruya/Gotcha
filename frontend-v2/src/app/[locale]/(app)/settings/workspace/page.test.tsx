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
const { stub, factRows, languageDrawer } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
  factRows: vi.fn((_props: { scan?: unknown }) => <div data-testid="facts" />),
  languageDrawer: vi.fn((_props: { systemLocale?: unknown }) => <div data-testid="language" />),
}));
vi.mock('@/features/workspace/FactRows', () => ({ FactRows: factRows }));
vi.mock('@/features/workspace/VoiceEditor', () => ({ VoiceEditor: stub('voice') }));
vi.mock('@/features/workspace/ProhibitedClaims', () => ({ ProhibitedClaims: stub('claims') }));
vi.mock('@/features/workspace/HoursDrawer', () => ({ HoursDrawer: stub('hours') }));
vi.mock('@/features/workspace/LanguageDrawer', () => ({ LanguageDrawer: languageDrawer }));
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
vi.mock('@/features/workspace/SlaDrawer', () => ({ SlaDrawer: stub('sla') }));
vi.mock('@/features/workspace/SlaRow', () => ({ SlaRow: stub('sla-row') }));
vi.mock('@/features/workspace/IdleDrawer', () => ({ IdleDrawer: stub('idle') }));
vi.mock('@/features/workspace/IdleRow', () => ({ IdleRow: stub('idle-row') }));
const idle = vi.hoisted(() => ({
  setup: {
    kind: 'owner',
    settings: {
      reminderEnabled: false,
      reminderDelayMinutes: 60,
      reminderMessage: 'Hi',
      autoCloseEnabled: false,
      autoCloseDelayMinutes: 1440,
      autoCloseMessage: '',
    },
  } as { kind: string; settings?: unknown },
}));
vi.mock('@/features/workspace/load-idle', () => ({ loadIdleSetup: async () => idle.setup }));
const sla = vi.hoisted(() => ({
  setup: { kind: 'owner', settings: { enabled: true, slaMinutes: 30, warningThreshold: 70 } } as {
    kind: string;
    settings?: unknown;
  },
  departments: vi.fn(async () => []),
}));
vi.mock('@/features/workspace/load-sla-setup', () => ({
  loadSlaSetup: async () => sla.setup,
  loadDepartmentSlas: sla.departments,
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
    ['language', 'drawer-language', 'language', 'System language'],
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

describe('★★ W2 - the response target: a row, and its drawer for an Owner', () => {
  it('the row is drawn in the facts card', async () => {
    await open();
    const props = factRows.mock.calls.at(-1)![0] as { sla?: unknown };
    expect(props.sla).toBeTruthy();
  });

  it('★★ ?panel=sla opens it for an Owner, with the departments read only then', async () => {
    sla.departments.mockClear();
    await open();
    expect(sla.departments).not.toHaveBeenCalled();
    await open('sla');
    expect(screen.getByTestId('drawer-sla')).toHaveAttribute('aria-label', 'Response target');
    expect(screen.getByTestId('sla')).toBeInTheDocument();
    expect(sla.departments).toHaveBeenCalledTimes(1);
  });

  it('★★ anyone else: no drawer, and nothing more is read', async () => {
    sla.setup = { kind: 'forbidden' };
    sla.departments.mockClear();
    await open('sla');
    expect(screen.queryByTestId('drawer-sla')).toBeNull();
    expect(sla.departments).not.toHaveBeenCalled();
    sla.setup = {
      kind: 'owner',
      settings: { enabled: true, slaMinutes: 30, warningThreshold: 70 },
    };
  });
});

describe('★★ W1 - the system language reaches the row and the drawer', () => {
  it('the row gets it', async () => {
    await open();
    expect((factRows.mock.calls.at(-1)![0] as { systemLocale?: unknown }).systemLocale).toBe('he');
  });

  it('the drawer gets it, and nothing else', async () => {
    await open('language');
    expect(languageDrawer.mock.calls.at(-1)![0]).toEqual({ systemLocale: 'he' });
  });
});

describe('★★ S3 - follow-up and auto-close: a row, and its drawer for an Owner', () => {
  it('the row is drawn in the facts card', async () => {
    await open();
    expect((factRows.mock.calls.at(-1)![0] as { idle?: unknown }).idle).toBeTruthy();
  });

  it('★★ ?panel=idle opens it for an Owner', async () => {
    await open('idle');
    expect(screen.getByTestId('drawer-idle')).toHaveAttribute(
      'aria-label',
      'Follow-up and auto-close',
    );
    expect(screen.getByTestId('idle')).toBeInTheDocument();
  });

  it('★★ anyone else: no drawer', async () => {
    const was = idle.setup;
    idle.setup = { kind: 'forbidden' };
    await open('idle');
    expect(screen.queryByTestId('drawer-idle')).toBeNull();
    idle.setup = was;
  });
});
