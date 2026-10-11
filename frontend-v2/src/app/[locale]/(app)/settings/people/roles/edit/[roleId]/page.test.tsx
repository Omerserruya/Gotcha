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
vi.mock('@/features/roles/RoleForm', async () => {
  const { useState } = await import('react');
  return {
    // Holds what it was first given, as the real form seeds its selection once.
    RoleForm: ({ editing }: { editing: { id: string; features: string[] } }) => {
      const [seeded] = useState(() => editing.features.join(','));
      return <div data-testid="role-form" data-editing={editing.id} data-seeded={seeded} />;
    },
  };
});
vi.mock('@/features/roles/load-catalog', () => ({
  loadCatalog: async () => ({ permissions: [] }),
}));
// What the server holds for Department Manager - changed by "Reset to default" below.
const dmState = vi.hoisted(() => ({ customized: true, features: ['crm:contacts:read'] }));

// Through the real contract, as `loadRoles` reads them.
vi.mock('@/features/roles/load-roles', async () => {
  const { roleListSchema } = await import('@/api/contracts/roles');
  return {
    loadRoles: async () =>
      roleListSchema.parse({
        data: [
          {
            id: 'admin',
            name: 'Admin',
            isSystem: true,
            builtinKey: 'admin',
            editable: false,
            features: [{ feature: '*' }],
            _count: { assignments: 1 },
          },
          {
            id: 'dm',
            name: 'Department Manager',
            isSystem: true,
            builtinKey: 'department_manager',
            editable: true,
            customized: dmState.customized,
            features: dmState.features.map((feature) => ({ feature })),
          },
          // The kill switch on (or a backend before 30d610da): fixed.
          { id: 'agent', name: 'Agent', isSystem: true, builtinKey: 'agent', editable: false },
          { id: 'w', name: 'Wholesale rep', isSystem: false, builtinKey: null },
        ],
      }),
  };
});

import Page from './page';

const open = async (roleId: string) => render(await Page({ params: Promise.resolve({ roleId }) }));

describe('★★ a built-in role opens in the form when the server says `editable` (auth 30d610da)', () => {
  it('an editable built-in role opens in the form, on itself', async () => {
    await open('dm');
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-editing', 'dm');
    expect(screen.queryByTestId('role-edit-builtin')).toBeNull();
  });

  it('a custom role still opens in the form', async () => {
    await open('w');
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-editing', 'w');
  });

  it('a built-in role the server keeps fixed: said, with Create role - never Duplicate', async () => {
    await open('agent');
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

  it('★ the merged Admin: "now part of Owner", and no form', async () => {
    await open('admin');
    expect(screen.getByTestId('role-edit-merged')).toHaveTextContent(roles.merged);
    expect(screen.queryByTestId('role-form')).toBeNull();
  });
});

describe('★ after "Reset to default", the fresh read seeds the form again', () => {
  it('the form is a new one when what the role holds changed - not the old selection', async () => {
    dmState.customized = true;
    dmState.features = ['crm:contacts:read'];
    const view = render(await Page({ params: Promise.resolve({ roleId: 'dm' }) }));
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-seeded', 'crm:contacts:read');
    // The reset happened; router.refresh() renders the page again on the server's new answer.
    dmState.customized = false;
    dmState.features = ['conversation:messages:*', 'crm:contacts:read'];
    view.rerender(await Page({ params: Promise.resolve({ roleId: 'dm' }) }));
    expect(screen.getByTestId('role-form')).toHaveAttribute(
      'data-seeded',
      'conversation:messages:*,crm:contacts:read',
    );
  });
});
