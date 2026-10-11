import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import people from '@/i18n/messages/en/people.json';
import roles from '@/i18n/messages/en/roles.json';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { roles, people },
      namespace: namespace as 'roles',
    }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  redirect: vi.fn(),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ actions, children }: { actions: ReactNode; children: ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('@/features/people/PeopleTabs', () => ({ PeopleTabs: () => <nav data-testid="tabs" /> }));
vi.mock('@/features/roles/RoleList', () => ({
  RoleList: () => <section data-testid="role-list" />,
}));
vi.mock('@/features/roles/load-roles', () => ({
  loadRoles: async () => [{ id: 'r1', name: 'Agent', features: [] }],
}));
vi.mock('@/features/people/load-people', () => ({
  loadPeople: async () => ({ members: [], aiEmployees: [], teams: [] }),
}));

import Page from './page';

describe('★ 12b without the two tiles (Omer, 2026-10-11)', () => {
  it('the roles and the foot - and no tile to People or to AI employees', async () => {
    const { container } = render(await Page());
    // What stays, so the absence below is read on a screen that rendered.
    expect(screen.getByTestId('role-list')).toBeInTheDocument();
    expect(screen.getByTestId('role-create-open')).toHaveAttribute(
      'href',
      '/settings/people/roles/new',
    );
    expect(container).toHaveTextContent(roles.foot);

    expect(screen.queryByTestId('card-extra')).toBeNull();
    expect(screen.queryByTestId('card-ai')).toBeNull();
    expect(container.querySelector('a[href="/settings/people"]')).toBeNull();
    expect(container.querySelector('a[href="/studio/capabilities"]')).toBeNull();
    expect(container).not.toHaveTextContent(/Open People|Open Studio|AI employees/);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('the foot no longer sends anyone to a Duplicate that is gone', () => {
    expect(roles.foot).not.toMatch(/duplicate/i);
    expect(JSON.stringify(roles)).not.toMatch(/duplicat/i);
    expect(roles).not.toHaveProperty('cards');
  });
});
