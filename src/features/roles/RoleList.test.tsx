import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { memberSchema } from '@/api/contracts/people';
import { roleSchema } from '@/api/contracts/roles';
import roles from '@/i18n/messages/en/roles.json';

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
  it('a built-in role: its description, a lock, and Duplicate → the form, from it', async () => {
    render(
      await RoleList({
        roles: [role({ id: 'admin', name: 'Admin', isSystem: true, description: 'Everything.' })],
      }),
    );
    expect(screen.getByTestId('builtin-admin')).toHaveTextContent('Built-in');
    expect(screen.getByTestId('allows-admin')).toHaveTextContent('Everything.');
    expect(screen.getByTestId('action-admin').querySelector('a')).toHaveAttribute(
      'href',
      '/settings/people/roles/new?from=admin',
    );
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
