import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import employees from '@/i18n/messages/en/employees.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'employees') =>
    createTranslator({ locale: 'en', messages: { employees }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: { query: { employee: string } };
    children: ReactNode;
  }) => (
    <a href={`?employee=${href.query.employee}`} {...rest}>
      {children}
    </a>
  ),
}));

import { EmployeeRail } from './EmployeeRail';

const employee = (over: Record<string, unknown>) =>
  employeeSchema.parse({ id: 'a', name: 'Customer Support', ...over });

describe('★ 07’s list: a row per employee', () => {
  it('★★ an active one counts its conversations as OPEN - never "live"', async () => {
    render(
      await EmployeeRail({
        employees: [employee({ status: 'ACTIVE', openConversations: 88 })],
        selectedId: 'a',
      }),
    );
    const row = screen.getByTestId('rail-a');
    expect(row).toHaveTextContent('88 open');
    expect(row).not.toHaveTextContent(/live/i);
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('a paused one says so instead of a count; the unselected row is not current', async () => {
    render(
      await EmployeeRail({
        employees: [employee({}), employee({ id: 'b', name: 'Wholesale', status: 'PAUSED' })],
        selectedId: 'a',
      }),
    );
    expect(screen.getByTestId('rail-b')).toHaveTextContent('Paused');
    expect(screen.getByTestId('rail-b')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('rail-b')).toHaveAttribute('href', '?employee=b');
  });
});

describe('★ the list’s foot is 02’s sentence, as far as it is true', () => {
  it('says knowledge reaches every employee that READS it - not "everyone"', async () => {
    render(await EmployeeRail({ employees: [employee({})], selectedId: 'a' }));
    const foot = screen.getByTestId('list-foot');
    expect(foot).toHaveTextContent('every employee that reads it learns it');
    expect(foot).not.toHaveTextContent(/everyone/i);
  });
});
