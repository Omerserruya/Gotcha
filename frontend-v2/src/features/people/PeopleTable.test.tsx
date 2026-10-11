import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { aiEmployeeSchema, memberSchema } from '@/api/contracts/people';
import people from '@/i18n/messages/he/people.json';
import roles from '@/i18n/messages/he/roles.json';
import { expectPlainRow, expectStretchedRow } from '@/test/stretched-row';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'people' | 'roles') =>
    createTranslator({ locale: 'he', messages: { people, roles }, namespace }),
  getLocale: async () => 'he',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href: _href, ...rest }: { children: ReactNode; href: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { PeopleTable } from './PeopleTable';

describe('★★ the roster’s “Can do” - a built-in role in Hebrew, by its key', () => {
  it('built-in by key; legacy enum by key; a custom role in its owner’s words, even one called "Admin"', async () => {
    render(
      await PeopleTable({
        members: [
          memberSchema.parse({ id: 'a', name: 'Maya', roleName: 'Admin', roleBuiltinKey: 'admin' }),
          memberSchema.parse({
            id: 'b',
            name: 'Tomer',
            roleName: 'Department Manager',
            roleBuiltinKey: 'department_manager',
          }),
          memberSchema.parse({ id: 'c', name: 'Noa', legacyRole: 'AGENT' }),
          memberSchema.parse({ id: 'd', name: 'Dan', roleName: 'Admin', roleBuiltinKey: null }),
        ],
        aiEmployees: [],
        presence: [],
      }),
    );
    expect(screen.getByTestId('person-role-a')).toHaveTextContent(/^מנהל\/ת$/);
    expect(screen.getByTestId('person-role-b')).toHaveTextContent(/^מנהל\/ת מחלקה$/);
    expect(screen.getByTestId('person-role-c')).toHaveTextContent(/^נציג\/ה$/);
    expect(screen.getByTestId('person-role-d')).toHaveTextContent(/^Admin$/);
  });
});

describe('★★ a person’s whole row opens their drawer (Omer, 2026-10-11)', () => {
  it('a person: the name, stretched, the only tab stop; an AI employee’s row has nothing to open', async () => {
    render(
      await PeopleTable({
        members: [memberSchema.parse({ id: 'a', name: 'Maya', roleBuiltinKey: 'admin' })],
        aiEmployees: [aiEmployeeSchema.parse({ id: 'x', name: 'Dana' })],
        presence: [],
      }),
    );
    expect(expectStretchedRow(screen.getByTestId('person-row-a'))).toBe(
      screen.getByTestId('person-name-a'),
    );
    expectPlainRow(screen.getByTestId('person-row-x'));
  });
});
