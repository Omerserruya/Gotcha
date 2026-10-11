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
  Link: ({ children, href: _href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => (
    <div>
      <header data-testid="section-actions">{actions}</header>
      {children}
    </div>
  ),
}));
vi.mock('@/shell/Drawer', () => ({
  Drawer: ({
    testId,
    title,
    lead,
    children,
  }: {
    testId: string;
    title: string;
    lead?: ReactNode;
    children: ReactNode;
  }) => (
    <aside data-testid={testId} aria-label={title}>
      {lead}
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
    expect(screen.getByTestId('person-disc')).toHaveTextContent(/^TA$/);
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

describe('★ 12 - the team cards sit under the people list, as 02 draws them', () => {
  it('People tab: the table, then the teams', async () => {
    await open({});
    const table = screen.getByTestId('table');
    const teams = screen.getByTestId('teams');
    expect(table.compareDocumentPosition(teams) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('★ 12 - inviting is the People tab’s, not the Teams view’s (Omer, 2026-10-11)', () => {
  it('Teams: the teams, and no "Invite someone" - in the header or anywhere', async () => {
    await open({ tab: 'teams' });
    expect(screen.getByTestId('teams')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-open')).toBeNull();
    expect(screen.getByTestId('section-actions')).toBeEmptyDOMElement();
    expect(screen.queryByTestId('invite')).toBeNull();
    expect(screen.queryByText(people.invite.open)).toBeNull();
  });

  it('Teams with ?invite=1 still opens nothing', async () => {
    await open({ tab: 'teams', invite: '1' });
    expect(screen.queryByTestId('invite')).toBeNull();
    expect(screen.queryByTestId('invite-open')).toBeNull();
  });

  it('People keeps its invite exactly: the header link and the invite row', async () => {
    await open({});
    expect(screen.getByTestId('invite-open')).toHaveTextContent(people.invite.open);
    expect(screen.getByTestId('invite')).toBeInTheDocument();
  });
});
