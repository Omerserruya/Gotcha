import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import people from '@/i18n/messages/en/people.json';
import roles from '@/i18n/messages/en/roles.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: 'en',
      messages: { roles, people },
      namespace: namespace as 'roles',
    }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={typeof href === 'string' ? href : JSON.stringify(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/features/roles/RoleForm', () => ({ RoleForm: () => <div data-testid="role-form" /> }));
vi.mock('@/features/roles/load-catalog', () => ({
  loadCatalog: async () => ({ permissions: [] }),
}));
vi.mock('@/features/roles/load-roles', () => ({
  loadRoles: async () => [
    { id: 'admin', name: 'Admin', isSystem: true, builtinKey: 'admin', features: ['*'] },
    { id: 'w', name: 'Wholesale rep', isSystem: false, builtinKey: null, features: [] },
  ],
}));

import Page from './page';

const open = async (roleId: string) => render(await Page({ params: Promise.resolve({ roleId }) }));

describe('★ a built-in role is not edited - and is not duplicated either', () => {
  it('says so, and offers Create role - never Duplicate, never `?from=`', async () => {
    await open('admin');
    const said = screen.getByTestId('role-edit-builtin');
    expect(said).toHaveTextContent(/built in and can't be changed/);
    expect(screen.getByTestId('role-edit-create')).toHaveAttribute(
      'href',
      '/settings/people/roles/new',
    );
    expect(said).not.toHaveTextContent(/duplicate/i);
    expect(document.querySelector('a[href*="from"]')).toBeNull();
    expect(screen.queryByTestId('role-form')).toBeNull();
  });

  it('a custom role still opens in the form', async () => {
    await open('w');
    expect(screen.getByTestId('role-form')).toBeInTheDocument();
  });
});
