import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import people from '@/i18n/messages/en/people.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'people') =>
    createTranslator({ locale: 'en', messages: { people }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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
const { stub, loadPerson } = vi.hoisted(() => ({
  stub: (id: string) => (props: Record<string, unknown>) => (
    <div data-testid={id} data-props={JSON.stringify(Object.keys(props).sort())} />
  ),
  loadPerson: vi.fn(),
}));
vi.mock('@/features/people/InviteForm', () => ({ InviteForm: stub('invite') }));
vi.mock('@/features/people/PeopleTabs', () => ({ PeopleTabs: stub('tabs') }));
vi.mock('@/features/people/PeopleTable', () => ({ PeopleTable: stub('table') }));
vi.mock('@/features/people/TeamCards', () => ({ TeamCards: stub('teams') }));
vi.mock('@/features/roles/PersonPanel', () => ({ PersonPanel: stub('person-panel') }));
vi.mock('@/features/roles/GrantPicker', () => ({ GrantPicker: stub('grant-picker') }));
vi.mock('@/features/roles/load-person', () => ({ loadPerson }));
vi.mock('@/features/roles/load-catalog', () => ({
  loadCatalog: async () => ({ permissions: [] }),
}));
vi.mock('@/features/roles/load-roles', () => ({
  loadRoles: async () => [{ id: 'r1', name: 'Agent', description: 'Answers' }],
}));
vi.mock('@/features/people/load-people', () => ({
  loadPeople: async () => ({
    members: [{ id: 'u1', roleId: 'r1', roleName: 'Agent', departments: [] }],
    aiEmployees: [],
    teams: [],
    presence: [],
  }),
}));

import Page from './page';

const TOMER = {
  id: 'u1',
  name: 'Tomer Adler',
  email: 'tomer@example.com',
  grants: [],
  permissions: [],
};
const open = async (params: Record<string, string>) =>
  render(await Page({ searchParams: Promise.resolve(params) }));

describe('★ 12d over People, 12e over 12d', () => {
  it('?person= opens the person’s drawer, titled with their name', async () => {
    loadPerson.mockResolvedValue(TOMER);
    await open({ person: 'u1' });
    expect(screen.getByTestId('drawer-person')).toHaveAttribute('aria-label', 'Tomer Adler');
    expect(screen.getByTestId('person-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('grant-picker')).toBeNull();
    expect(screen.getByTestId('table')).toBeInTheDocument();
  });

  it('&grant=1 opens the picker over it', async () => {
    loadPerson.mockResolvedValue(TOMER);
    await open({ person: 'u1', grant: '1' });
    expect(screen.getByTestId('grant-picker')).toBeInTheDocument();
  });

  it('a person who cannot be read opens nothing', async () => {
    loadPerson.mockResolvedValue(null);
    await open({ person: 'nobody' });
    expect(screen.queryByTestId('drawer-person')).toBeNull();
  });
});
