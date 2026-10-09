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
  RoleForm: ({ initialSourceId }: { initialSourceId: string }) => (
    <div data-testid="role-form" data-from={initialSourceId} />
  ),
}));
vi.mock('@/features/roles/load-catalog', () => ({ loadCatalog }));
vi.mock('@/features/roles/load-roles', () => ({
  loadRoles: async () => [{ id: 'r1', name: 'Agent', features: [] }],
}));

import Page from './page';

describe('★ 12c is a page: "← Roles" above "New role"', () => {
  it('starts from ?from= when it names a role, and from nothing otherwise', async () => {
    loadCatalog.mockResolvedValue({ permissions: [] });
    const { unmount } = render(await Page({ searchParams: Promise.resolve({ from: 'r1' }) }));
    expect(screen.getByRole('heading')).toHaveTextContent('New role');
    expect(screen.getByTestId('back')).toHaveAttribute('href', '/settings/people/roles');
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-from', 'r1');
    unmount();
    render(await Page({ searchParams: Promise.resolve({ from: 'nope' }) }));
    expect(screen.getByTestId('role-form')).toHaveAttribute('data-from', '');
  });

  it('no catalogue, no form: a role of no permissions is not offered', async () => {
    loadCatalog.mockResolvedValue(null);
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByTestId('role-form')).toBeNull();
    expect(screen.getByTestId('role-form-unavailable')).toBeInTheDocument();
  });
});
