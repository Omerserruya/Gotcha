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
vi.mock('@/shell/SettingsSection', () => ({
  SettingsSection: ({
    title,
    back,
    children,
  }: {
    title: string;
    back: { href: string; label: string };
    children: ReactNode;
  }) => (
    <div>
      <a data-testid="back" href={back.href}>
        {back.label}
      </a>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
const { loadCatalog } = vi.hoisted(() => ({ loadCatalog: vi.fn() }));
vi.mock('@/features/roles/RoleForm', () => ({
  RoleForm: (props: Record<string, unknown>) => (
    <div data-testid="role-form" data-props={Object.keys(props).sort().join(',')} />
  ),
}));
vi.mock('@/features/roles/load-catalog', () => ({ loadCatalog }));
vi.mock('@/features/roles/load-roles', () => ({
  loadRoles: async () => [{ id: 'r1', name: 'Agent', features: [] }],
}));

import Page from './page';

describe('★ 12c is a page: "← Roles" above "New role"', () => {
  it('the form, given the catalogue and the roles - and no Duplicate source', async () => {
    loadCatalog.mockResolvedValue({ permissions: [] });
    render(await Page());
    expect(screen.getByRole('heading')).toHaveTextContent('New role');
    expect(screen.getByTestId('back')).toHaveAttribute('href', '/settings/people/roles');
    // ★ 12b's Duplicate is gone (Omer, 2026-10-11): nothing seeds the form from `?from=`.
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-props', 'permissions,roles');
  });

  it('no catalogue, no form: a role of no permissions is not offered', async () => {
    loadCatalog.mockResolvedValue(null);
    render(await Page());
    expect(screen.queryByTestId('role-form')).toBeNull();
    expect(screen.getByTestId('role-form-unavailable')).toBeInTheDocument();
  });
});
