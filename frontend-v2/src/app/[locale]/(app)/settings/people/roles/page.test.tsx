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
  it('the roles - and no tile to People or to AI employees', async () => {
    const { container } = render(await Page());
    // What stays, so the absence below is read on a screen that rendered.
    expect(screen.getByTestId('role-list')).toBeInTheDocument();
    expect(screen.getByTestId('role-create-open')).toHaveAttribute(
      'href',
      '/settings/people/roles/new',
    );

    expect(screen.queryByTestId('card-extra')).toBeNull();
    expect(screen.queryByTestId('card-ai')).toBeNull();
    expect(container.querySelector('a[href="/settings/people"]')).toBeNull();
    expect(container.querySelector('a[href="/studio/capabilities"]')).toBeNull();
    expect(container).not.toHaveTextContent(/Open People|Open Studio|AI employees/);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('nothing sends anyone to a Duplicate that is gone', () => {
    expect(JSON.stringify(roles)).not.toMatch(/duplicat/i);
    expect(roles).not.toHaveProperty('cards');
  });
});

describe('★★ built-in roles are editable (auth 30d610da): the "can\'t be changed" foot is gone', () => {
  // The sentence, in both catalogues, as it stood - read from neither, so a
  // copy that drifts back in under another key is still caught.
  const SENTENCES = [
    'תפקידים מובנים אי אפשר לשנות או למחוק',
    "Built-in roles can't be changed or deleted",
  ];

  it('the page draws no foot', async () => {
    const { container } = render(await Page());
    expect(screen.getByTestId('role-list')).toBeInTheDocument();
    for (const sentence of SENTENCES) expect(container.textContent).not.toContain(sentence);
  });

  it('neither catalogue holds the sentence, under any key', async () => {
    const he = (await import('@/i18n/messages/he/roles.json')).default;
    expect(roles).not.toHaveProperty('foot');
    expect(he).not.toHaveProperty('foot');
    for (const sentence of SENTENCES) {
      expect(JSON.stringify(roles)).not.toContain(sentence);
      expect(JSON.stringify(he)).not.toContain(sentence);
    }
  });
});
