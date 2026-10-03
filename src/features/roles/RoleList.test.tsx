import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

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
    href: { query: Record<string, string> };
    children: ReactNode;
  }) => (
    <a href={`?${new URLSearchParams(href.query)}`} {...rest}>
      {children}
    </a>
  ),
}));

import { RoleList } from './RoleList';

const role = (over: Record<string, unknown>) =>
  roleSchema.parse({ id: 'r', name: 'Agent', features: ['inbox:read'], ...over });

describe('★ 12b — the roles as one table', () => {
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
      '?create=1&from=admin',
    );
  });

  it('★ a custom role: "Custom" (no creator is recorded), and Edit drawn, not live', async () => {
    render(await RoleList({ roles: [role({ id: 'w', name: 'Wholesale rep' })] }));
    expect(screen.getByTestId('role-w')).toHaveTextContent('Custom');
    expect(screen.getByTestId('role-w')).not.toHaveTextContent(/ by /);
    const edit = screen.getByTestId('action-w').firstElementChild!;
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(edit.tagName).not.toBe('A');
  });

  it('★ a wildcard role says "everything", never "one thing"; nobody is "No one yet"', async () => {
    render(await RoleList({ roles: [role({ id: 'o', features: ['*'], memberCount: 0 })] }));
    expect(screen.getByTestId('allows-o')).toHaveTextContent('Allows everything');
    expect(screen.getByTestId('members-o')).toHaveTextContent('No one yet');
  });
});
