import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import people from '@/i18n/messages/en/people.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'people') =>
    createTranslator({ locale: 'en', messages: { people }, namespace }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href: _href, ...rest }: { href: unknown; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { PeopleTabs } from './PeopleTabs';

describe('★ 12 / 12b — People · Roles · Teams', () => {
  it('marks the open one and counts each — a failed read shows no count, never 0', async () => {
    render(await PeopleTabs({ current: 'roles', counts: { people: 4, roles: 4, teams: null } }));
    expect(screen.getByTestId('people-tab-roles')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('people-tab-people')).toHaveTextContent(/^People4$/);
    expect(screen.getByTestId('people-tab-teams')).toHaveTextContent(/^Teams$/);
  });
});
