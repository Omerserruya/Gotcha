import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { memberSchema } from '@/api/contracts/people';
import { roleListSchema, roleSchema } from '@/api/contracts/roles';
import roles from '@/i18n/messages/en/roles.json';
import rowLink from '@/design-system/styles/row-link.module.css';
import { expectPlainRow, expectStretchedRow } from '@/test/stretched-row';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'roles') =>
    createTranslator({ locale: 'en', messages: { roles }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query: Record<string, string> };
    children: ReactNode;
  }) => (
    <a
      href={typeof href === 'string' ? href : `${href.pathname}?${new URLSearchParams(href.query)}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));

import { RoleList } from './RoleList';

const role = (over: Record<string, unknown>) =>
  roleSchema.parse({ id: 'r', name: 'Agent', features: ['inbox:read'], ...over });

describe('★ 12b - the roles as one table', () => {
  it('a built-in role: its description, a lock - and no action at all', async () => {
    render(
      await RoleList({
        roles: [role({ id: 'admin', name: 'Admin', isSystem: true, description: 'Everything.' })],
      }),
    );
    expect(screen.getByTestId('builtin-admin')).toHaveTextContent('Built-in');
    expect(screen.getByTestId('allows-admin')).toHaveTextContent('Everything.');
    // ★ No Duplicate (Omer, 2026-10-11): the cell is empty, not a link to a copy.
    expect(screen.getByTestId('action-admin')).toBeEmptyDOMElement();
    expect(screen.queryByRole('link', { name: /duplicate/i })).toBeNull();
    expect(document.querySelector('a[href*="from="]')).toBeNull();
  });

  it('★ a custom role: "Custom" (no creator is recorded), and Edit opens it in the form', async () => {
    render(await RoleList({ roles: [role({ id: 'w', name: 'Wholesale rep' })] }));
    expect(screen.getByTestId('role-w')).toHaveTextContent('Custom');
    expect(screen.getByTestId('role-w')).not.toHaveTextContent(/ by /);
    const edit = screen.getByTestId('edit-w');
    expect(edit.tagName).toBe('A');
    expect(edit).toHaveAttribute('href', '/settings/people/roles/edit/w');
  });

  it('★ a wildcard role says "everything", never "one thing"; nobody is "No one yet"', async () => {
    render(await RoleList({ roles: [role({ id: 'o', features: ['*'], memberCount: 0 })] }));
    expect(screen.getByTestId('allows-o')).toHaveTextContent('Allows everything');
    expect(screen.getByTestId('members-o')).toHaveTextContent('No one yet');
  });
});

describe('★ 12b’s PEOPLE - 02’s faces, from the roster', () => {
  const owner = role({
    id: 'owner',
    name: 'Owner',
    isSystem: true,
    builtinKey: 'owner',
    memberCount: 1,
  });

  it('a face per person who holds it - by id, or by the built-in key - named on hover', async () => {
    render(
      await RoleList({
        roles: [owner],
        members: [
          memberSchema.parse({ id: 'u1', name: 'Maya Levi', roleBuiltinKey: 'owner' }),
          memberSchema.parse({ id: 'u2', name: 'Tomer Adler', roleId: 'other' }),
        ],
      }),
    );
    const people = screen.getByTestId('members-owner');
    expect(people).toHaveTextContent('ML');
    expect(people).not.toHaveTextContent('TA');
    expect(people.querySelector('[title]')).toHaveAttribute('title', 'Maya Levi');
  });

  it('roster unread: the count, as before - never an empty row of faces', async () => {
    render(await RoleList({ roles: [owner], members: null }));
    expect(screen.getByTestId('members-owner')).toHaveTextContent('One person');
  });
});

describe('★★ a built-in role in the reader’s words - by its key', () => {
  it('Hebrew: the catalogue’s name and description, never the platform’s English', async () => {
    const heRoles = (await import('@/i18n/messages/he/roles.json')).default;
    const words = createTranslator({
      locale: 'he',
      messages: { roles: heRoles },
      namespace: 'roles',
    });
    const server = await import('next-intl/server');
    vi.spyOn(server, 'getTranslations').mockResolvedValueOnce(words as never);
    render(
      await RoleList({
        roles: [
          role({
            id: 'dm',
            name: 'Department Manager',
            isSystem: true,
            builtinKey: 'department_manager',
            description: 'Runs a department: full conversation/approval handling…',
          }),
          role({ id: 'w', name: 'Admin', description: 'Ours.' }),
        ],
      }),
    );
    expect(screen.getByTestId('role-dm')).toHaveTextContent(
      heRoles.builtinRole.department_manager.name,
    );
    expect(screen.getByTestId('allows-dm')).toHaveTextContent(/^ניהול מחלקה/);
    expect(screen.getByTestId('role-dm')).not.toHaveTextContent('Runs a department');
    // A custom role keeps the name its owner typed - even "Admin".
    expect(screen.getByTestId('role-w')).toHaveTextContent(/^Admin/);
    expect(screen.getByTestId('allows-w')).toHaveTextContent('Ours.');
  });
});

describe('★★ a custom role’s whole row opens it (Omer, 2026-10-11)', () => {
  it('custom: Edit, stretched, the only tab stop; built-in: nothing to open, nothing stretched', async () => {
    render(
      await RoleList({
        roles: [
          role({ id: 'w', name: 'Wholesale rep' }),
          role({ id: 'admin', name: 'Admin', isSystem: true }),
        ],
        members: [memberSchema.parse({ id: 'm', name: 'Maya Cohen', roleId: 'w' })],
      }),
    );
    expect(expectStretchedRow(screen.getByTestId('role-w'))).toBe(screen.getByTestId('edit-w'));
    expectPlainRow(screen.getByTestId('role-admin'));
  });

  it('★ the faces keep their names on hover: above the overlay', async () => {
    render(
      await RoleList({
        roles: [role({ id: 'w', name: 'Wholesale rep' })],
        members: [memberSchema.parse({ id: 'm', name: 'Maya Cohen', roleId: 'w' })],
      }),
    );
    const faces = screen.getByTitle('Maya Cohen');
    // Above the overlay for their names, and a click on them still opens the role (RowTipForward).
    expect(faces.classList.contains(rowLink.tip!)).toBe(true);
  });
});

describe('★★ built-in roles are editable where the server says so (auth 30d610da)', () => {
  const dm = (over: Record<string, unknown> = {}) =>
    role({
      id: 'dm',
      name: 'Department Manager',
      isSystem: true,
      builtinKey: 'department_manager',
      editable: true,
      ...over,
    });

  it('editable: its row opens it in the form, and no lock is drawn', async () => {
    render(await RoleList({ roles: [dm()] }));
    expect(screen.getByTestId('edit-dm')).toHaveAttribute('href', '/settings/people/roles/edit/dm');
    expect(screen.getByTestId('builtin-dm')).toHaveTextContent('Built-in');
    expect(screen.getByTestId('builtin-dm').querySelector('svg')).toBeNull();
  });

  it('not editable (an older backend, or the kill switch): the lock, and nothing to open', async () => {
    render(await RoleList({ roles: [dm({ editable: false })] }));
    expect(screen.getByTestId('action-dm')).toBeEmptyDOMElement();
    expect(screen.getByTestId('builtin-dm').querySelector('svg')).not.toBeNull();
  });

  it('changed by the workspace: says so, and is counted - not the shipped description', async () => {
    render(
      await RoleList({
        roles: [dm({ customized: true, features: ['crm:contacts:read', 'crm:contacts:update'] })],
      }),
    );
    expect(screen.getByTestId('builtin-dm')).toHaveTextContent(roles.builtinChanged);
    expect(screen.getByTestId('allows-dm')).toHaveTextContent('Allows 2 things');
    expect(screen.getByTestId('allows-dm')).not.toHaveTextContent(
      roles.builtinRole.department_manager.description,
    );
  });
});

describe('★★ Admin is part of Owner (auth 30d610da)', () => {
  it('absent from the API: no Admin row, in either language', async () => {
    const list = roleListSchema.parse({
      data: [
        { id: 'o', name: 'Owner', isSystem: true, builtinKey: 'owner', editable: true },
        { id: 'a', name: 'Agent', isSystem: true, builtinKey: 'agent', editable: true },
      ],
    });
    render(await RoleList({ roles: list }));
    expect(screen.getByTestId('role-list')).toHaveTextContent(roles.builtinRole.owner.name);
    expect(screen.getByTestId('role-list')).not.toHaveTextContent(roles.builtinRole.admin.name);
    expect(screen.queryByTestId('role-admin')).toBeNull();
  });

  it('★ returned (someone still holds it): fixed, with the note - even if it says editable', async () => {
    const [admin] = roleListSchema.parse({
      data: [
        {
          id: 'admin',
          name: 'Admin',
          isSystem: true,
          builtinKey: 'admin',
          editable: true,
          _count: { assignments: 1 },
        },
      ],
    });
    render(await RoleList({ roles: [admin!] }));
    expect(screen.getByTestId('allows-admin')).toHaveTextContent(roles.merged);
    expect(screen.getByTestId('action-admin')).toBeEmptyDOMElement();
    expect(screen.getByTestId('builtin-admin').querySelector('svg')).not.toBeNull();
    expectPlainRow(screen.getByTestId('role-admin'));
  });
});
